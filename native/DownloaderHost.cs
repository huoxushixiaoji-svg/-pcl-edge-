using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

public sealed class HostConfig {
    public string extensionId { get; set; }
    public string downloadFolder { get; set; }
    public int connections { get; set; }
}
public sealed class HostRequest {
    public string action { get; set; }
    public string requestId { get; set; }
    public string jobId { get; set; }
    public string url { get; set; }
    public string filename { get; set; }
}
public sealed class JobSpec {
    public string jobId { get; set; }
    public string url { get; set; }
    public string outputPath { get; set; }
    public string reservationPath { get; set; }
    public int connections { get; set; }
}
public sealed class JobStatus {
    public string jobId { get; set; }
    public string state { get; set; }
    public string message { get; set; }
    public string outputPath { get; set; }
    public long downloadedBytes { get; set; }
    public long totalBytes { get; set; }
    public long bytesPerSecond { get; set; }
    public long updatedUtcMs { get; set; }
}
public sealed class ProbeResult {
    public long Length;
    public bool SupportsRanges;
}

public static class DownloaderHost {
    static readonly string HomeDir = AppDomain.CurrentDomain.BaseDirectory;
    static readonly string JobsDir = Path.Combine(HomeDir, "jobs");
    static readonly string ReservationsDir = Path.Combine(HomeDir, "reservations");
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 262144 };
    static readonly DateTime Epoch = new DateTime(1970,1,1,0,0,0,DateTimeKind.Utc);
    const int MaxFrame = 262144;
    const string Version = "0.3.0";
    const uint CREATE_BREAKAWAY_FROM_JOB = 0x01000000;
    const uint CREATE_NO_WINDOW = 0x08000000;
    const uint DETACHED_PROCESS = 0x00000008;

    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]
    struct STARTUPINFO { public int cb; public string reserved; public string desktop; public string title; public int x,y,xSize,ySize,xChars,yChars,fillAttribute,flags; public short showWindow,reserved2; public IntPtr reservedPtr,stdInput,stdOutput,stdError; }
    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION { public IntPtr process; public IntPtr thread; public int processId; public int threadId; }
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
    static extern bool CreateProcess(string applicationName,StringBuilder commandLine,IntPtr processAttributes,IntPtr threadAttributes,bool inheritHandles,uint creationFlags,IntPtr environment,string currentDirectory,ref STARTUPINFO startupInfo,out PROCESS_INFORMATION processInformation);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

    [STAThread]
    public static int Main(string[] args) {
        if (args.Length == 1 && args[0] == "--self-test") {
            try { SelfTest(); return 0; } catch (Exception e) { File.WriteAllText(Path.Combine(HomeDir,"self-test-error.txt"),e.ToString()); return 10; }
        }
        if (args.Length == 2 && args[0] == "--worker") {
            try { RunWorker(args[1]); return 0; } catch { return 20; }
        }
        try {
            HostConfig config = ReadConfig();
            string origin = "chrome-extension://" + config.extensionId + "/";
            if (!args.Any(a => String.Equals(a.TrimEnd('/'), origin.TrimEnd('/'), StringComparison.Ordinal))) return 11;
            using (Stream input = Console.OpenStandardInput())
            using (Stream output = Console.OpenStandardOutput()) {
                while (true) {
                    string frame = ReadFrame(input);
                    if (frame == null) return 0;
                    HostRequest request = Json.Deserialize<HostRequest>(frame);
                    Dictionary<string,object> response;
                    try { response = Handle(config,request); }
                    catch (Exception e) { response = Result(request,"failed",false,e.Message,true); }
                    WriteFrame(output,Json.Serialize(response));
                }
            }
        } catch { return 12; }
    }

    static HostConfig ReadConfig() {
        HostConfig config = Json.Deserialize<HostConfig>(File.ReadAllText(Path.Combine(HomeDir,"config.json"),Encoding.UTF8));
        if (config == null || !Regex.IsMatch(config.extensionId ?? "", "^[a-p]{32}$")) throw new Exception("本机下载器配置损坏，请重新安装。");
        config.downloadFolder = NormalizeFolder(config.downloadFolder);
        config.connections = Math.Max(1,Math.Min(config.connections <= 0 ? 8 : config.connections,16));
        return config;
    }
    static Dictionary<string,object> Result(HostRequest r,string status,bool ok,string message,bool safe) {
        return new Dictionary<string,object> {
            {"requestId",r == null ? "" : r.requestId},{"status",status},{"ok",ok},{"message",message},
            {"safeToResume",safe},{"hostVersion",Version}
        };
    }
    static Dictionary<string,object> Handle(HostConfig config,HostRequest r) {
        if (r == null || String.IsNullOrWhiteSpace(r.requestId) || r.requestId.Length > 100) throw new Exception("无效请求编号。");
        Directory.CreateDirectory(JobsDir); Directory.CreateDirectory(ReservationsDir);
        if (r.action == "test") {
            Directory.CreateDirectory(config.downloadFolder); CheckWritable(config.downloadFolder);
            Dictionary<string,object> ready = Result(r,"ready",true,"独立下载器连接正常。",true);
            ready["downloadFolder"] = config.downloadFolder; ready["connections"] = config.connections; return ready;
        }
        ValidateJobId(r.jobId);
        if (r.action == "status") return StatusResult(r,ReadStatus(r.jobId));
        if (r.action == "cancel" || r.action == "pause" || r.action == "resume") {
            JobStatus current = ReadStatus(r.jobId);
            if (current == null) return Result(r,"failed",false,"未找到任务，请刷新任务状态。",false);
            if (!new[]{"queued","downloading","paused"}.Contains(current.state)) return StatusResult(r,current);
            if (r.action == "cancel") File.WriteAllText(CancelPath(r.jobId),"cancel",Encoding.ASCII);
            else if (r.action == "pause") File.WriteAllText(PausePath(r.jobId),"pause",Encoding.ASCII);
            else File.Delete(PausePath(r.jobId));
            Dictionary<string,object> result = Result(r,"ready",true,"已发送任务控制指令。",false);
            result["jobState"] = r.action == "pause" ? "pausing" : r.action == "resume" ? "resuming" : "canceling";
            return result;
        }
        if (r.action != "download") throw new Exception("不支持的操作。");
        ValidateUrl(r.url); Directory.CreateDirectory(config.downloadFolder); CheckWritable(config.downloadFolder);
        using (Mutex mutex = new Mutex(false,"Local\\EdgeMultiDownload.Queue")) {
            bool held = false;
            try {
                try { held = mutex.WaitOne(3000); } catch (AbandonedMutexException) { held = true; }
                if (!held) throw new Exception("本机下载器正忙，请稍后重试。");
                JobStatus existing = ReadStatus(r.jobId);
                if (existing != null) return Accepted(r,existing);
                string reservation; string output = ReserveOutput(config.downloadFolder,SafeName(r.filename),out reservation);
                JobSpec spec = new JobSpec { jobId=r.jobId,url=r.url,outputPath=output,reservationPath=reservation,connections=config.connections };
                WriteJsonAtomic(JobPath(r.jobId),spec);
                JobStatus queued = NewStatus(spec,"queued","任务已进入独立下载器队列。",0,-1); WriteStatus(queued);
                try { StartWorker(JobPath(r.jobId)); }
                catch { TryDelete(JobPath(r.jobId)); TryDelete(StatusPath(r.jobId)); TryDelete(reservation); throw; }
                return Accepted(r,queued);
            } finally { if (held) mutex.ReleaseMutex(); }
        }
    }
    static Dictionary<string,object> Accepted(HostRequest r,JobStatus status) {
        Dictionary<string,object> result = Result(r,"submitted",true,"独立下载任务已启动。",false);
        result["jobId"] = status.jobId; result["outputPath"] = status.outputPath; result["jobState"] = status.state; return result;
    }
    static Dictionary<string,object> StatusResult(HostRequest r,JobStatus status) {
        Dictionary<string,object> result = Result(r,"ready",true,status == null ? "未找到任务。" : status.message,true);
        result["jobId"] = r.jobId; result["jobState"] = status == null ? "missing" : status.state;
        if (status != null) { result["outputPath"] = status.outputPath; result["downloadedBytes"] = status.downloadedBytes; result["totalBytes"] = status.totalBytes; result["bytesPerSecond"] = status.bytesPerSecond; }
        return result;
    }

    static void StartWorker(string jobFile) {
        string executable=Process.GetCurrentProcess().MainModule.FileName;
        StringBuilder command=new StringBuilder("\""+executable+"\" --worker \""+jobFile.Replace("\"","\\\"")+"\"");
        STARTUPINFO startup=new STARTUPINFO();startup.cb=Marshal.SizeOf(typeof(STARTUPINFO));PROCESS_INFORMATION process;
        if(!CreateProcess(executable,command,IntPtr.Zero,IntPtr.Zero,false,CREATE_BREAKAWAY_FROM_JOB|CREATE_NO_WINDOW|DETACHED_PROCESS,IntPtr.Zero,HomeDir,ref startup,out process))
            throw new Exception("无法在浏览器进程之外启动下载任务（Windows 错误 "+Marshal.GetLastWin32Error()+"）。");
        CloseHandle(process.thread);CloseHandle(process.process);
    }
    static void RunWorker(string jobFile) {
        JobSpec spec = Json.Deserialize<JobSpec>(File.ReadAllText(jobFile,Encoding.UTF8)); ValidateJobId(spec.jobId); ValidateUrl(spec.url);
        using (WorkerControl control = new WorkerControl(spec)) try {
            ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
            control.Start();
            Download(spec,control);
            long length = new FileInfo(spec.outputPath).Length;
            control.Finish("completed","下载完成。",length,length);
        } catch (Exception e) {
            // Publish terminal status only after partial files have been removed.
            TryDelete(TempOutput(spec)); TryDeleteDirectory(PartsDir(spec.jobId));
            bool canceled = control.Token.IsCancellationRequested || File.Exists(CancelPath(spec.jobId)) || e is OperationCanceledException;
            control.Finish(canceled ? "canceled" : "failed",canceled ? "已取消下载并清理临时文件。" : "下载失败：" + e.Message);
        } finally {
            TryDelete(jobFile); TryDelete(spec.reservationPath); TryDelete(CancelPath(spec.jobId)); TryDelete(PausePath(spec.jobId));
            TryDelete(TempOutput(spec)); TryDeleteDirectory(PartsDir(spec.jobId));
        }
    }
    // One control object owns progress, cooperative pause and cancellation for all parts.
    sealed class WorkerControl : IDisposable {
        readonly JobSpec spec;
        readonly object sync = new object();
        readonly CancellationTokenSource cancellation = new CancellationTokenSource();
        Timer timer;
        long downloaded, total = -1, lastBytes, lastTick = Now();
        bool finished;
        public WorkerControl(JobSpec value) { spec = value; }
        public CancellationToken Token { get { return cancellation.Token; } }
        public void Start() { Tick(null); timer = new Timer(Tick,null,250,500); }
        public void SetTotal(long value) { lock(sync) total = value; }
        public void Add(long value) { lock(sync) downloaded = Math.Max(0,downloaded + value); }
        public void WriteChunk(Stream output,byte[] buffer,int count,bool countProgress) {
            while(true) {
                Gate();
                lock(sync) {
                    if(File.Exists(PausePath(spec.jobId))) continue;
                    Token.ThrowIfCancellationRequested();
                    if(File.Exists(CancelPath(spec.jobId))) throw new OperationCanceledException();
                    output.Write(buffer,0,count);
                    if(countProgress) downloaded+=count;
                    return;
                }
            }
        }
        public void Gate() {
            while(true) {
                if(File.Exists(CancelPath(spec.jobId))) cancellation.Cancel();
                Token.ThrowIfCancellationRequested();
                if(!File.Exists(PausePath(spec.jobId))) return;
                if(Token.WaitHandle.WaitOne(100)) Token.ThrowIfCancellationRequested();
            }
        }
        void Tick(object unused) {
            if(File.Exists(CancelPath(spec.jobId))) cancellation.Cancel();
            lock(sync) {
                if(finished) return;
                bool paused = File.Exists(PausePath(spec.jobId));
                long now=Now(), elapsed=Math.Max(1,now-lastTick);
                JobStatus status=NewStatus(spec,paused ? "paused" : "downloading",paused ? "已暂停，可继续下载。" : "正在下载。",downloaded,total);
                status.bytesPerSecond=paused ? 0 : Math.Max(0,(downloaded-lastBytes)*1000/elapsed);
                lastBytes=downloaded;lastTick=now;
                try { WriteStatus(status); } catch(IOException) { /* Next tick retries status publishing. */ }
            }
        }
        public void Finish(string state,string message,long bytes=-1,long length=-1) {
            lock(sync) {
                finished=true;
                WriteStatus(NewStatus(spec,state,message,bytes<0 ? downloaded : bytes,length<0 ? total : length));
            }
        }
        public void Dispose() { if(timer!=null) { using(ManualResetEvent done=new ManualResetEvent(false)) { timer.Dispose(done);done.WaitOne(); } } cancellation.Dispose(); }
    }
    static void Download(JobSpec spec,WorkerControl control) {
        control.Gate();
        ProbeResult probe = Probe(spec.url,control);
        control.SetTotal(probe.Length);
        int count = probe.SupportsRanges && probe.Length >= 2*1024*1024 ? Math.Min(spec.connections,(int)Math.Max(1,probe.Length/(1024*1024))) : 1;
        if (count <= 1) { DownloadSingle(spec,probe.Length,control); return; }
        string parts = PartsDir(spec.jobId); Directory.CreateDirectory(parts);
        long segment = (probe.Length + count - 1) / count;
        List<Task> tasks = new List<Task>();
        for (int i=0;i<count;i++) {
            int index=i; long start=segment*i; long end=Math.Min(probe.Length-1,start+segment-1);
            tasks.Add(Task.Run(() => DownloadPart(spec,index,start,end,probe.Length,control)));
        }
        try { Task.WaitAll(tasks.ToArray()); }
        catch (AggregateException e) { throw e.Flatten().InnerExceptions.First(); }
        control.Gate();
        string temp=TempOutput(spec);
        using (FileStream output=new FileStream(temp,FileMode.CreateNew,FileAccess.Write,FileShare.None)) {
            for(int i=0;i<count;i++) using(FileStream input=File.OpenRead(Path.Combine(parts,"part-"+i))) Copy(input,output,control,false);
        }
        if(new FileInfo(temp).Length!=probe.Length)throw new IOException("分段合并后的文件大小不一致。");
        control.Gate(); File.Move(temp,spec.outputPath);
    }
    static ProbeResult Probe(string url,WorkerControl control) {
        using(HttpClient client=CreateClient()) using(HttpRequestMessage request=new HttpRequestMessage(HttpMethod.Get,url)) {
            request.Headers.Range=new RangeHeaderValue(0,0);
            using(HttpResponseMessage response=client.SendAsync(request,HttpCompletionOption.ResponseHeadersRead,control.Token).GetAwaiter().GetResult()) {
                control.Gate();
                if(response.StatusCode==HttpStatusCode.PartialContent && response.Content.Headers.ContentRange != null && response.Content.Headers.ContentRange.From==0 && response.Content.Headers.ContentRange.To==0 && response.Content.Headers.ContentRange.Length.HasValue)
                    return new ProbeResult {Length=response.Content.Headers.ContentRange.Length.Value,SupportsRanges=true};
                if(!response.IsSuccessStatusCode)throw new HttpRequestException("服务器返回 HTTP "+(int)response.StatusCode+"。");
                return new ProbeResult {Length=response.Content.Headers.ContentLength ?? -1,SupportsRanges=false};
            }
        }
    }
    static HttpClient CreateClient() {
        HttpClient client=new HttpClient(new HttpClientHandler {AllowAutoRedirect=true,MaxAutomaticRedirections=10,AutomaticDecompression=DecompressionMethods.None,UseCookies=false});
        client.Timeout=TimeSpan.FromMinutes(30); client.DefaultRequestHeaders.UserAgent.ParseAdd("EdgeMultiDownload/"+Version); return client;
    }
    static void DownloadSingle(JobSpec spec,long expected,WorkerControl control) {
        string temp=TempOutput(spec);
        using(HttpClient client=CreateClient()) using(HttpResponseMessage response=client.GetAsync(spec.url,HttpCompletionOption.ResponseHeadersRead,control.Token).GetAwaiter().GetResult()) {
            if(!response.IsSuccessStatusCode)throw new HttpRequestException("服务器返回 HTTP "+(int)response.StatusCode+"。");
            if(expected<0) control.SetTotal(response.Content.Headers.ContentLength ?? -1);
            using(Stream input=response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()) using(FileStream output=new FileStream(temp,FileMode.CreateNew,FileAccess.Write,FileShare.None)) Copy(input,output,control,true);
        }
        if(expected>=0 && new FileInfo(temp).Length!=expected)throw new IOException("下载文件大小与服务器声明不一致。");
        control.Gate(); File.Move(temp,spec.outputPath);
    }
    static void DownloadPart(JobSpec spec,int index,long start,long end,long total,WorkerControl control) {
        string path=Path.Combine(PartsDir(spec.jobId),"part-"+index); Exception last=null;
        for(int attempt=0;attempt<3;attempt++) {
            control.Gate(); TryDelete(path); long copied=0;
            try {
                using(HttpClient client=CreateClient()) using(HttpRequestMessage request=new HttpRequestMessage(HttpMethod.Get,spec.url)) {
                    request.Headers.Range=new RangeHeaderValue(start,end);
                    using(HttpResponseMessage response=client.SendAsync(request,HttpCompletionOption.ResponseHeadersRead,control.Token).GetAwaiter().GetResult()) {
                        ContentRangeHeaderValue range=response.Content.Headers.ContentRange;
                        if(response.StatusCode!=HttpStatusCode.PartialContent || range==null || range.From!=start || range.To!=end || range.Length!=total)throw new IOException("服务器未接受正确的分段请求。");
                        using(Stream input=response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()) using(FileStream output=new FileStream(path,FileMode.CreateNew,FileAccess.Write,FileShare.Read)) Copy(input,output,control,true);
                    }
                }
                if(new FileInfo(path).Length!=end-start+1)throw new IOException("下载分段大小不一致。"); return;
            } catch(Exception e) {
                last=e; if(File.Exists(path)) copied=new FileInfo(path).Length;
                control.Add(-copied); TryDelete(path); control.Gate();
                if(attempt<2 && control.Token.WaitHandle.WaitOne(500*(attempt+1))) control.Token.ThrowIfCancellationRequested();
            }
        }
        throw last;
    }
    static void Copy(Stream input,Stream output,WorkerControl control,bool countProgress) {
        using(control.Token.Register(() => { try { input.Dispose(); } catch {} })) {
            byte[] buffer=new byte[128*1024]; int count;
            while(true) {
                control.Gate(); count=input.ReadAsync(buffer,0,buffer.Length,control.Token).GetAwaiter().GetResult();
                if(count==0) break;
                control.WriteChunk(output,buffer,count,countProgress);
            }
        }
    }

    public static string SafeName(string input) {
        string s=Regex.Replace(input ?? "download","[<>:\"/\\\\|?*\\x00-\\x1f\\x7f]","_").TrimEnd('.',' ');
        if(String.IsNullOrWhiteSpace(s))s="download";
        if(Regex.IsMatch(s,@"^(CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³]|CONIN\$|CONOUT\$)(\.|$)",RegexOptions.IgnoreCase))s="_"+s;
        return (s.Length>160?s.Substring(0,160):s).TrimEnd('.',' ');
    }
    static void ValidateUrl(string value) {
        Uri uri;
        if(String.IsNullOrEmpty(value)||value.Length>32768||value.Any(Char.IsControl)||!Uri.TryCreate(value,UriKind.Absolute,out uri)||
           (uri.Scheme!=Uri.UriSchemeHttp&&uri.Scheme!=Uri.UriSchemeHttps)||!String.IsNullOrEmpty(uri.UserInfo)) throw new Exception("只接受不含账号密码的 HTTP/HTTPS 直链。");
    }
    static void ValidateJobId(string value) { Guid parsed; if(!Guid.TryParseExact(value,"D",out parsed))throw new Exception("无效任务标识。"); }
    static string NormalizeFolder(string folder) {
        if(String.IsNullOrWhiteSpace(folder))throw new Exception("未配置下载目录，请重新安装。");
        string full=Path.GetFullPath(folder.Trim()); if(!Path.IsPathRooted(full))throw new Exception("下载目录必须是完整路径。"); return full;
    }
    static string ReserveOutput(string folder,string name,out string marker) {
        string ext=Path.GetExtension(name),stem=Path.GetFileNameWithoutExtension(name);
        for(int i=0;i<10000;i++) {
            string candidate=i==0?name:stem+" ("+i+")"+ext; string output=Path.Combine(folder,candidate);
            if(output.Length>245)throw new Exception("保存路径过长，请选择较短的下载目录。");
            if(File.Exists(output)||Directory.Exists(output))continue;
            string hash; using(SHA256 sha=SHA256.Create())hash=BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(output.ToUpperInvariant()))).Replace("-","");
            marker=Path.Combine(ReservationsDir,hash+".lock");
            try { using(new FileStream(marker,FileMode.CreateNew,FileAccess.Write,FileShare.None)){} return output; } catch(IOException) { if(!File.Exists(marker))throw; }
        }
        throw new Exception("同名任务过多，请更换文件名。");
    }
    static void CheckWritable(string folder) { string p=Path.Combine(folder,".edge-download-"+Guid.NewGuid().ToString("N")+".tmp"); using(new FileStream(p,FileMode.CreateNew,FileAccess.Write,FileShare.None)){} File.Delete(p); }
    static JobStatus NewStatus(JobSpec spec,string state,string message,long downloaded,long total) { return new JobStatus {jobId=spec.jobId,state=state,message=message,outputPath=spec.outputPath,downloadedBytes=downloaded,totalBytes=total,updatedUtcMs=Now()}; }
    static JobStatus ReadStatus(string id) {
        string path=StatusPath(id);
        try { using(FileStream input=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.ReadWrite|FileShare.Delete)) using(StreamReader reader=new StreamReader(input,Encoding.UTF8)) return Json.Deserialize<JobStatus>(reader.ReadToEnd()); }
        catch { return null; }
    }
    static void WriteStatus(JobStatus status) { WriteJsonAtomic(StatusPath(status.jobId),status); }
    static void WriteJsonAtomic(string path,object value) {
        string temp=path+"."+Guid.NewGuid().ToString("N")+".tmp";
        try { File.WriteAllText(temp,new JavaScriptSerializer { MaxJsonLength=MaxFrame }.Serialize(value),new UTF8Encoding(false)); if(File.Exists(path))File.Replace(temp,path,null);else File.Move(temp,path); }
        finally { TryDelete(temp); }
    }
    static string JobPath(string id){return Path.Combine(JobsDir,id+".job.json");} static string StatusPath(string id){return Path.Combine(JobsDir,id+".status.json");}
    static string CancelPath(string id){return Path.Combine(JobsDir,id+".cancel");} static string PartsDir(string id){return Path.Combine(JobsDir,id+".parts");}
    static string PausePath(string id){return Path.Combine(JobsDir,id+".pause");}
    static string TempOutput(JobSpec spec){return Path.Combine(Path.GetDirectoryName(spec.outputPath),"."+Path.GetFileName(spec.outputPath)+"."+spec.jobId+".edgepart");}
    static long Now(){return (long)(DateTime.UtcNow-Epoch).TotalMilliseconds;} static void TryDelete(string p){try{if(!String.IsNullOrEmpty(p)&&File.Exists(p))File.Delete(p);}catch{}}
    static void TryDeleteDirectory(string p){try{if(Directory.Exists(p))Directory.Delete(p,true);}catch{}}
    static string ReadFrame(Stream input){byte[] h=new byte[4];int n=ReadExact(input,h,4);if(n==0)return null;if(n!=4)throw new EndOfStreamException();int len=BitConverter.ToInt32(h,0);if(len<=0||len>MaxFrame)throw new InvalidDataException();byte[] b=new byte[len];if(ReadExact(input,b,len)!=len)throw new EndOfStreamException();return Encoding.UTF8.GetString(b);}
    static int ReadExact(Stream s,byte[] b,int count){int total=0,n;while(total<count&&(n=s.Read(b,total,count-total))>0)total+=n;return total;}
    static void WriteFrame(Stream output,string value){byte[] b=Encoding.UTF8.GetBytes(value),h=BitConverter.GetBytes(b.Length);output.Write(h,0,4);output.Write(b,0,b.Length);output.Flush();}
    static void SelfTest(){if(SafeName("CON.zip")!="_CON.zip")throw new Exception("name");ValidateUrl("https://example.com/file.zip");string folder=Path.Combine(Path.GetTempPath(),"EdgeMultiDownloadSelfTest-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(folder);try{CheckWritable(folder);JobStatus s=new JobStatus{jobId=Guid.NewGuid().ToString(),state="ready"};WriteJsonAtomic(Path.Combine(folder,"status.json"),s);if(!File.Exists(Path.Combine(folder,"status.json")))throw new Exception("json");}finally{TryDeleteDirectory(folder);}}
}
