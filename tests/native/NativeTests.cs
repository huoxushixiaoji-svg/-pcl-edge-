// Test-only adapter: production Windows builds use System.Web.Extensions directly.
namespace System.Web.Script.Serialization {
    public sealed class JavaScriptSerializer {
        public int MaxJsonLength { get; set; }
        public string Serialize(object value) { return System.Text.Json.JsonSerializer.Serialize(value); }
        public T Deserialize<T>(string value) { return System.Text.Json.JsonSerializer.Deserialize<T>(value); }
    }
}

public static class NativeTests {
    static readonly System.Reflection.BindingFlags Private = System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.NonPublic;
    static readonly string Root = System.AppDomain.CurrentDomain.BaseDirectory;
    static readonly string Jobs = System.IO.Path.Combine(Root,"jobs");
    static readonly byte[] Payload = MakePayload();
    static readonly System.Collections.Concurrent.ConcurrentDictionary<string,int> Attempts = new System.Collections.Concurrent.ConcurrentDictionary<string,int>();
    static System.Net.HttpListener server;
    static string origin;
    static byte[] MakePayload() { byte[] bytes = new byte[8*1024*1024];new System.Random(42).NextBytes(bytes);return bytes; }
    static object Invoke(string method,params object[] args) { return typeof(DownloaderHost).GetMethod(method,Private).Invoke(null,args); }
    static void Assert(bool value,string message) { if(!value)throw new System.Exception(message); }
    static JobStatus Status(string id) { return (JobStatus)Invoke("ReadStatus",id); }
    static async System.Threading.Tasks.Task Wait(System.Func<bool> check,string message,int timeout=10000) {
        var start=System.DateTime.UtcNow;
        while((System.DateTime.UtcNow-start).TotalMilliseconds<timeout) { if(check())return;await System.Threading.Tasks.Task.Delay(40); }
        throw new System.Exception("Timeout: "+message);
    }
    static System.Collections.Generic.Dictionary<string,object> Control(string id,string action) {
        var config=new HostConfig {downloadFolder=System.IO.Path.Combine(Root,"output"),connections=4};
        return (System.Collections.Generic.Dictionary<string,object>)Invoke("Handle",config,new HostRequest {requestId=System.Guid.NewGuid().ToString(),jobId=id,action=action});
    }
    static (JobSpec spec,System.Threading.Tasks.Task worker) Start(string route,int connections=4) {
        string id=System.Guid.NewGuid().ToString(),path=System.IO.Path.Combine(Jobs,id+".job.json");
        var spec=new JobSpec {jobId=id,url=origin+route,connections=connections,outputPath=System.IO.Path.Combine(Root,"output",id+".bin")};
        System.IO.File.WriteAllText(path,System.Text.Json.JsonSerializer.Serialize(spec));
        return (spec,System.Threading.Tasks.Task.Run(()=>Invoke("RunWorker",path)));
    }
    static async System.Threading.Tasks.Task Serve(System.Net.HttpListenerContext context) {
        try {
            string route=context.Request.Url.AbsolutePath;
            long start=0,end=Payload.Length-1;
            string range=context.Request.Headers["Range"];
            bool ranged=range!=null && route!="/single" && route!="/unknown" && route!="/stall";
            if(ranged) {
                string[] fields=range.Substring(6).Split('-');start=long.Parse(fields[0]);end=long.Parse(fields[1]);
                context.Response.StatusCode=206;
                long reported=route=="/bad-range" && end>0 ? start+1 : start;
                context.Response.AddHeader("Content-Range","bytes "+reported+"-"+end+"/"+Payload.Length);
            }
            if(route=="/unknown" || route=="/stall")context.Response.SendChunked=true;
            else context.Response.ContentLength64=end-start+1;
            if(route=="/stall") {
                await context.Response.OutputStream.WriteAsync(Payload,0,1);
                await context.Response.OutputStream.FlushAsync();
                await System.Threading.Tasks.Task.Delay(10000);return;
            }
            bool retry=route=="/retry" && ranged && end>0 && Attempts.AddOrUpdate(range,1,(_,count)=>count+1)==1;
            long written=0;
            for(long offset=start;offset<=end;) {
                int count=(int)System.Math.Min(32*1024,end-offset+1);
                await context.Response.OutputStream.WriteAsync(Payload,(int)offset,count);
                await context.Response.OutputStream.FlushAsync();offset+=count;written+=count;
                if(retry && written>=64*1024) { context.Response.Abort();return; }
                if(end>0)await System.Threading.Tasks.Task.Delay(20);
            }
        } catch(System.Exception) { /* Canceled client requests disconnect from the fixture. */ }
        finally { context.Response.Close(); }
    }
    static async System.Threading.Tasks.Task Accept() {
        while(server.IsListening) {
            try { var context=await server.GetContextAsync();_ = Serve(context); }
            catch(System.Net.HttpListenerException) { return; }
            catch(System.ObjectDisposedException) { return; }
        }
    }
    static void Completed(JobSpec spec) {
        JobStatus status=Status(spec.jobId);
        Assert(status.state=="completed",status.message);
        Assert(status.downloadedBytes==Payload.Length && status.totalBytes==Payload.Length,"Final progress bytes differ");
        Assert(System.Linq.Enumerable.SequenceEqual(System.IO.File.ReadAllBytes(spec.outputPath),Payload),"Downloaded bytes differ");
        Assert(!System.IO.Directory.Exists(System.IO.Path.Combine(Jobs,spec.jobId+".parts")),"Parts remain after completion");
    }
    static async System.Threading.Tasks.Task PauseResume() {
        var job=Start("/range");string id=job.spec.jobId;
        await Wait(()=>Status(id)?.downloadedBytes>128*1024,"initial progress");
        Assert((bool)Control(id,"pause")["ok"],"Pause rejected");
        await Wait(()=>Status(id)?.state=="paused","worker pause confirmation");
        var other=Start("/range");
        await System.Threading.Tasks.Task.Delay(600);long paused=Status(id).downloadedBytes;
        await System.Threading.Tasks.Task.Delay(1000);
        Assert(Status(id).downloadedBytes==paused,"Bytes changed while paused");
        Assert(!job.worker.IsCompleted,"Pause finished the task");
        await Wait(()=>other.worker.IsCompleted,"another task continues while first is paused");await other.worker;Completed(other.spec);
        Assert(Status(id).state=="paused" && Status(id).downloadedBytes==paused,"Other task changed paused progress");
        Assert((bool)Control(id,"resume")["ok"],"Resume rejected");
        await Wait(()=>job.worker.IsCompleted,"resumed completion");await job.worker;Completed(job.spec);
        System.Console.WriteLine("PASS per-task ranged progress, pause, resume, simultaneous download and exact file bytes");
    }
    static async System.Threading.Tasks.Task Cancel(string route,bool paused) {
        var job=Start(route);string id=job.spec.jobId;
        await Wait(()=>Status(id)?.downloadedBytes>0,"cancel initial progress");
        if(paused) { Control(id,"pause");await Wait(()=>Status(id)?.state=="paused","cancel paused state"); }
        Control(id,"cancel");await Wait(()=>job.worker.IsCompleted,"prompt cancellation",4000);await job.worker;
        Assert(Status(id).state=="canceled","Cancel not confirmed");
        Assert(!System.IO.File.Exists(job.spec.outputPath),"Canceled output exists");
        Assert(!System.IO.Directory.Exists(System.IO.Path.Combine(Jobs,id+".parts")),"Canceled parts remain");
        Assert(!System.IO.File.Exists(System.IO.Path.Combine(Jobs,id+".pause")),"Pause marker remains");
        Assert(System.IO.Directory.GetFiles(System.IO.Path.Combine(Root,"output"),"*"+id+"*.edgepart").Length==0,"Temporary output remains");
        System.Console.WriteLine("PASS cancel "+route+(paused ? " while paused" : " while reading"));
    }
    public static async System.Threading.Tasks.Task<int> Main() {
        System.IO.Directory.CreateDirectory(Jobs);System.IO.Directory.CreateDirectory(System.IO.Path.Combine(Root,"output"));
        var socket=new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback,0);socket.Start();int port=((System.Net.IPEndPoint)socket.LocalEndpoint).Port;socket.Stop();
        origin="http://127.0.0.1:"+port;server=new System.Net.HttpListener();server.Prefixes.Add(origin+"/");server.Start();var accepting=Accept();
        try {
            await PauseResume();await Cancel("/range",true);await Cancel("/single",false);await Cancel("/stall",false);
            foreach(string route in new[]{"/single","/unknown","/retry"}) {
                var job=Start(route);await Wait(()=>job.worker.IsCompleted,"completion "+route,15000);await job.worker;Completed(job.spec);
                System.Console.WriteLine("PASS exact file bytes "+route);
            }
            var bad=Start("/bad-range");await Wait(()=>bad.worker.IsCompleted,"invalid range");await bad.worker;
            Assert(Status(bad.spec.jobId).state=="failed" && !System.IO.File.Exists(bad.spec.outputPath),"Invalid ranges produced an output");
            System.Console.WriteLine("PASS reject incorrect Content-Range");return 0;
        } catch(System.Exception e) { System.Console.Error.WriteLine(e);return 1; }
        finally {
            server.Stop();server.Close();await accepting;
            System.IO.Directory.Delete(Jobs,true);System.IO.Directory.Delete(System.IO.Path.Combine(Root,"output"),true);
            string reservations=System.IO.Path.Combine(Root,"reservations");if(System.IO.Directory.Exists(reservations))System.IO.Directory.Delete(reservations,true);
        }
    }
}
