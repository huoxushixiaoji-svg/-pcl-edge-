using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Automation;

public sealed class BridgeConfig {
    public string pclPath { get; set; }
    public string extensionId { get; set; }
}
public sealed class Request {
    public string action { get; set; }
    public string requestId { get; set; }
    public string url { get; set; }
    public string filename { get; set; }
    public long deadlineUtcMs { get; set; }
}
public static class Bridge {
    static readonly string HomeDir = AppDomain.CurrentDomain.BaseDirectory;
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 262144 };
    static BridgeConfig Config;
    static long Deadline;
    static IntPtr MainWindow;
    static int PclPid;
    static bool EnterAttempted;
    const int MaxFrame = 262144;
    static readonly DateTime Epoch = new DateTime(1970,1,1,0,0,0,DateTimeKind.Utc);

    [MTAThread]
    public static int Main(string[] args) {
        if (args.Length == 1 && args[0] == "--self-test") {
            try { SelfTest(); return 0; } catch { return 10; }
        }
        try {
            Config = Json.Deserialize<BridgeConfig>(File.ReadAllText(Path.Combine(HomeDir,"config.json"),Encoding.UTF8));
            string origin = "chrome-extension://" + Config.extensionId + "/";
            if (!args.Any(a => String.Equals(a.TrimEnd('/'), origin.TrimEnd('/'), StringComparison.Ordinal))) return 11;
            using (Stream input = Console.OpenStandardInput())
            using (Stream output = Console.OpenStandardOutput()) {
                while (true) {
                    string frame = ReadFrame(input);
                    if (frame == null) return 0;
                    Request req = Json.Deserialize<Request>(frame);
                    Dictionary<string,object> result;
                    try { result = Handle(req); }
                    catch (Exception e) { result = Result(req, EnterAttempted ? "uncertain" : "failed", false, e.Message, !EnterAttempted); }
                    WriteFrame(output,Json.Serialize(result));
                }
            }
        } catch { return 12; }
    }
    static Dictionary<string,object> Result(Request r, string status, bool ok, string message, bool safe) {
        return new Dictionary<string,object> { {"requestId",r == null ? "" : r.requestId}, {"status",status}, {"ok",ok}, {"message",message}, {"safeToResume",safe}, {"bridgeVersion","0.1.2"} };
    }
    static Dictionary<string,object> Handle(Request r) {
        if (r == null || String.IsNullOrEmpty(r.requestId) || r.requestId.Length > 100) throw new Exception("无效任务编号。");
        if (r.action != "test" && r.action != "download") throw new Exception("不支持的操作。");
        long now = Now();
        Deadline = Math.Min(r.deadlineUtcMs,now + 80000);
        CheckTime();
        EnterAttempted = false;
        string reservation = null;
        string outputPath = null;
        bool mutexHeld = false;
        using (Mutex mutex = new Mutex(false,"Local\\PclEdgeBridge.UI")) {
            try {
                try { mutexHeld = mutex.WaitOne(1000); } catch (AbandonedMutexException) { mutexHeld = true; }
                if (!mutexHeld) throw new Exception("另一个 PCL 交接正在进行，请稍后再试。");
                if (Config == null || !File.Exists(Config.pclPath)) throw new Exception("找不到已配置的 PCL，请重新运行 Install.cmd。");
                if (r.action == "download") ValidateUrl(r.url);
                MainWindow = FindOrStartPcl();
                OpenToolbox();
                AutomationElement urlBox = NeedEdit("TextDownloadUrl");
                AutomationElement folderBox = NeedEdit("TextDownloadFolder");
                NeedEdit("TextDownloadName");
                // Read the live PCL field for EVERY request. Never replace it with an installer default.
                string downloadFolder = NormalizeDownloadFolder(GetText(folderBox));
                Directory.CreateDirectory(downloadFolder);
                CheckWritable(downloadFolder);
                if (r.action == "test") {
                    Dictionary<string,object> test = Result(r,"ready",true,"百宝箱控件检测通过。",true);
                    test["downloadFolder"] = downloadFolder;
                    test["folderSource"] = "pcl";
                    test["pclVersion"] = FileVersionInfo.GetVersionInfo(Config.pclPath).FileVersion;
                    return test;
                }
                // Do not overwrite a task the user is currently typing into the toolbox.
                if (!String.IsNullOrWhiteSpace(GetText(urlBox))) throw new Exception("百宝箱地址栏已有内容。请先完成或清空该任务，再重试。");
                string name = ReserveName(downloadFolder,SafeName(r.filename), out reservation);
                outputPath = Path.Combine(downloadFolder,name);
                SetText(urlBox,r.url);
                Sleep(350);
                SetText(NeedEdit("TextDownloadName"),name);
                Sleep(500);
                if (GetText(NeedEdit("TextDownloadUrl")) != r.url || GetText(NeedEdit("TextDownloadName")) != name ||
                    !String.Equals(NormalizeDownloadFolder(GetText(NeedEdit("TextDownloadFolder"))).TrimEnd('\\','/'),downloadFolder.TrimEnd('\\','/'),StringComparison.OrdinalIgnoreCase))
                    throw new Exception("PCL 中的下载信息与任务不一致，已停止交接。");
                string logPath = Path.Combine(Path.GetDirectoryName(Config.pclPath),"PCL","Log1.txt");
                long checkpoint = File.Exists(logPath) ? new FileInfo(logPath).Length : 0;
                urlBox = NeedEdit("TextDownloadUrl");
                FocusWindow();
                urlBox.SetFocus(); Sleep(100);
                AutomationElement focus = AutomationElement.FocusedElement;
                if (focus == null || focus.Current.ProcessId != PclPid || focus.Current.AutomationId != "TextDownloadUrl")
                    throw new Exception("无法聚焦 PCL 下载地址栏，请关闭 PCL 弹窗后重试。");
                CheckForeground(); CheckTime();
                // PCL 2.13.0.1 routes Enter in TextDownloadUrl to BtnDownloadStart_Click.
                EnterAttempted = true;
                SendEnter();
                long waitUntil = Math.Min(Deadline,Now()+14000);
                while (Now() < waitUntil) {
                    Thread.Sleep(250);
                    string tail = ReadLogTail(logPath,checkpoint);
                    int evidence = LogEvidence(tail,name);
                    if (evidence < 0) {
                        Dictionary<string,object> failed = Result(r,"uncertain",false,"PCL 已触发下载，但日志显示失败或取消。请检查任务后恢复 Edge。",false);
                        failed["outputPath"] = outputPath; return failed;
                    }
                    if (evidence > 0) {
                        Dictionary<string,object> sent = Result(r,"submitted",true,"PCL 日志已确认建立下载任务。",false);
                        sent["outputPath"] = outputPath; return sent;
                    }
                }
                Dictionary<string,object> unknown = Result(r,"uncertain",false,"已向 PCL 发送开始下载操作，但未获得任务日志确认。Edge 保持暂停；请查看 PCL 后选择如何处理。",false);
                unknown["outputPath"] = outputPath; return unknown;
            } catch (Exception e) {
                if (!EnterAttempted && reservation != null) {
                    try { File.Delete(reservation); } catch { }
                }
                Dictionary<string,object> fail = Result(r,EnterAttempted ? "uncertain" : "failed",false,
                    e.Message + (EnterAttempted ? " 请检查 PCL 中是否已有任务。" : " 尚未触发 PCL 下载。"),!EnterAttempted);
                if (outputPath != null) fail["outputPath"] = outputPath;
                return fail;
            } finally { if (mutexHeld) mutex.ReleaseMutex(); }
        }
    }

    static IntPtr FindOrStartPcl() {
        long stop = Math.Min(Deadline,Now()+40000);
        IntPtr handle = FindPcl();
        if (handle == IntPtr.Zero) {
            // Arguments contain no URL or file name; browser data never enters a shell.
            Process.Start(new ProcessStartInfo { FileName=Config.pclPath, WorkingDirectory=Path.GetDirectoryName(Config.pclPath), UseShellExecute=false });
        }
        while (Now()<stop) {
            handle = FindPcl();
            if (handle!=IntPtr.Zero) { MainWindow=handle; FocusWindow(); Sleep(500); return handle; }
            Sleep(250);
        }
        throw new Exception("未找到 PCL 主窗口。请先手动启动所选 PCL、完成首次提示，并保持与 Edge 相同的普通用户权限。");
    }
    static IntPtr FindPcl() {
        IntPtr found=IntPtr.Zero;
        EnumWindows(delegate(IntPtr handle,IntPtr unused) {
            uint pid; GetWindowThreadProcessId(handle,out pid);
            if (!IsWindowVisible(handle)) return true;
            StringBuilder title=new StringBuilder(512); GetWindowText(handle,title,title.Capacity);
            if (!title.ToString().StartsWith("Plain Craft Launcher",StringComparison.Ordinal)) return true;
            try {
                using (Process p=Process.GetProcessById((int)pid)) {
                    if (!String.Equals(Path.GetFullPath(p.MainModule.FileName),Path.GetFullPath(Config.pclPath),StringComparison.OrdinalIgnoreCase)) return true;
                }
                found=handle; PclPid=(int)pid; return false;
            } catch { return true; }
        },IntPtr.Zero);
        return found;
    }
    static AutomationElement Root() { return AutomationElement.FromHandle(MainWindow); }
    static AutomationElement ById(string id) {
        return Root().FindFirst(TreeScope.Descendants,new PropertyCondition(AutomationElement.AutomationIdProperty,id));
    }
    static AutomationElement ByName(string name) {
        AutomationElementCollection hits=Root().FindAll(TreeScope.Descendants,new PropertyCondition(AutomationElement.NameProperty,name));
        foreach (AutomationElement hit in hits) {
            try { if (!hit.Current.IsOffscreen && !hit.Current.BoundingRectangle.IsEmpty) return hit; } catch { }
        }
        return null;
    }
    static void OpenToolbox() {
        if (ById("TextDownloadUrl") != null) { RevealEdit(); return; }
        AutomationElement more=ByName("更多");
        // PCL inner pages hide the top navigation. A visible back control is safe to use.
        for(int n=0; more==null && n<4; n++) {
            AutomationElement back=ById("BtnTitleInner");
            if(back==null || back.Current.IsOffscreen) break;
            Click(back); Sleep(450); more=ByName("更多");
        }
        if(more==null) throw new Exception("未找到 PCL 的“更多”。请回到 PCL 主界面，并取消隐藏“更多”页面。");
        Click(more); Sleep(600);
        AutomationElement toolbox=null;
        for(int i=0;i<15 && toolbox==null;i++){toolbox=ByName("百宝箱");if(toolbox==null)Sleep(150);}
        if(toolbox==null) throw new Exception("未找到“百宝箱”。请在 PCL 个性化设置中显示该页面，并关闭弹窗。");
        Click(toolbox); Sleep(650);
        RevealEdit();
    }
    static void RevealEdit() {
        for(int i=0;i<18;i++) {
            CheckTime();
            AutomationElement box=ById("TextDownloadUrl");
            if(box!=null) {
                object pattern;
                if(box.TryGetCurrentPattern(ScrollItemPattern.Pattern,out pattern)) {
                    try { ((ScrollItemPattern)pattern).ScrollIntoView(); Sleep(150); } catch { }
                }
                if(!box.Current.IsOffscreen) return;
            }
            bool scrolled=false;
            AutomationElementCollection candidates=Root().FindAll(TreeScope.Descendants,new PropertyCondition(AutomationElement.IsScrollPatternAvailableProperty,true));
            foreach(AutomationElement candidate in candidates) {
                object pattern;
                if(candidate.Current.IsOffscreen || !candidate.TryGetCurrentPattern(ScrollPattern.Pattern,out pattern))continue;
                ScrollPattern scroll=(ScrollPattern)pattern;
                if(!scroll.Current.VerticallyScrollable)continue;
                try { scroll.Scroll(ScrollAmount.NoAmount,ScrollAmount.LargeIncrement);scrolled=true; } catch { }
            }
            if(!scrolled && box==null) { Sleep(200); }
            else Sleep(160);
        }
        throw new Exception("无法显示百宝箱下载输入框。请手动打开“更多 → 百宝箱”，向下滚动到“下载自定义文件”后重新检测。");
    }
    static AutomationElement NeedEdit(string id) {
        AutomationElement element=ById(id);
        object pattern;
        if(element==null || !element.TryGetCurrentPattern(ValuePattern.Pattern,out pattern) || ((ValuePattern)pattern).Current.IsReadOnly)
            throw new Exception("当前 PCL 不提供可用的下载输入框（"+id+"）。此版本可能需要适配。");
        return element;
    }
    static string GetText(AutomationElement e) { return ((ValuePattern)e.GetCurrentPattern(ValuePattern.Pattern)).Current.Value; }
    static void SetText(AutomationElement e,string value) { CheckTime(); ((ValuePattern)e.GetCurrentPattern(ValuePattern.Pattern)).SetValue(value); }
    static void FocusWindow() {
        CheckTime();
        if(IsIconic(MainWindow)) ShowWindow(MainWindow,9);
        SetForegroundWindow(MainWindow);
        Thread.Sleep(150);
        CheckForeground();
    }
    static void CheckForeground() {
        if(GetForegroundWindow()!=MainWindow) throw new Exception("PCL 未在前台或有弹窗遮挡。请点击 PCL 主窗口后重试。");
    }
    static void Click(AutomationElement e) {
        CheckTime(); FocusWindow();
        if(e.Current.ProcessId!=PclPid || e.Current.IsOffscreen || !e.Current.IsEnabled) throw new Exception("PCL 控件不可操作。");
        object pattern;
        if(e.TryGetCurrentPattern(InvokePattern.Pattern,out pattern)){((InvokePattern)pattern).Invoke();return;}
        if(e.TryGetCurrentPattern(SelectionItemPattern.Pattern,out pattern)){((SelectionItemPattern)pattern).Select();return;}
        // PCL uses custom Border/TextBlock controls without InvokePattern.
        // Resolve each live bounding rectangle; never use fixed screen coordinates.
        Rect rect=e.Current.BoundingRectangle;
        if(rect.IsEmpty || rect.Width<1 || rect.Height<1)throw new Exception("PCL 控件坐标不可用。");
        POINT point=new POINT { X=(int)(rect.Left+rect.Width/2), Y=(int)(rect.Top+rect.Height/2) };
        IntPtr hit=WindowFromPoint(point);
        uint pid; GetWindowThreadProcessId(hit,out pid);
        if(pid!=PclPid || GetAncestor(hit,2)!=MainWindow)throw new Exception("PCL 控件被其他窗口遮挡。");
        POINT previous; GetCursorPos(out previous);
        if(!SetCursorPos(point.X,point.Y))throw new Exception("无法定位 PCL 控件。");
        CheckForeground();
        INPUT[] inputs={MouseInput(2),MouseInput(4)};
        if(SendInput((uint)inputs.Length,inputs,Marshal.SizeOf(typeof(INPUT)))!=(uint)inputs.Length)throw new Exception("无法点击 PCL，请确保它未以管理员身份运行。");
        SetCursorPos(previous.X,previous.Y);
    }
    static INPUT MouseInput(uint flags){INPUT i=new INPUT();i.type=0;i.data.mouse.dwFlags=flags;return i;}
    static void SendEnter() {
        INPUT down=new INPUT();down.type=1;down.data.keyboard.wVk=13;
        INPUT up=down;up.data.keyboard.dwFlags=2;
        INPUT[] input={down,up};
        if(SendInput(2,input,Marshal.SizeOf(typeof(INPUT)))!=2)throw new Exception("PCL 未接受回车操作。");
    }

    public static string SafeName(string input) {
        string s=Regex.Replace(input ?? "download","[<>:\"/\\\\|?*\\x00-\\x1f\\x7f]","_").TrimEnd('.',' ');
        if(String.IsNullOrWhiteSpace(s))s="download";
        if(Regex.IsMatch(s,@"^(CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³]|CONIN\$|CONOUT\$)(\.|$)",RegexOptions.IgnoreCase))s="_"+s;
        return (s.Length>160?s.Substring(0,160):s).TrimEnd('.',' ');
    }
    public static void ValidateUrl(string text) {
        Uri uri;
        if(String.IsNullOrEmpty(text) || text.Length>32768 || text.Any(c=>Char.IsControl(c)) ||
            !Uri.TryCreate(text,UriKind.Absolute,out uri) || (uri.Scheme!="http" && uri.Scheme!="https") || !String.IsNullOrEmpty(uri.UserInfo))
            throw new Exception("只接受不含内嵌账号密码的 HTTP/HTTPS 下载直链。");
    }
    public static string NormalizeDownloadFolder(string currentPclFolder) {
        if (String.IsNullOrWhiteSpace(currentPclFolder))
            throw new Exception("PCL 百宝箱的“保存到”为空，请先在 PCL 中选择下载文件夹，再重新检测。");
        string folder=currentPclFolder.Trim();
        // Reject drive-relative and current-drive-rooted paths; PCL and this host have different working directories.
        if (!Regex.IsMatch(folder,@"^[A-Za-z]:[\\/]") && !Regex.IsMatch(folder,@"^\\\\[^\\/]+\\[^\\/]+(?:\\|$)"))
            throw new Exception("PCL 的“保存到”需要完整路径（例如 D:\\Downloads），请在百宝箱中重新选择文件夹。");
        if (folder.StartsWith(@"\\?\",StringComparison.Ordinal) || folder.StartsWith(@"\\.\",StringComparison.Ordinal))
            throw new Exception("请在 PCL 中选择普通磁盘目录或网络共享目录。");
        return Path.GetFullPath(folder);
    }
    static string ReserveName(string downloadFolder,string name,out string marker) {
        string dir=Path.Combine(HomeDir,"reservations");Directory.CreateDirectory(dir);
        string ext=Path.GetExtension(name),stem=Path.GetFileNameWithoutExtension(name);
        for(int i=0;i<10000;i++) {
            string candidate=i==0?name:stem+" ("+i+")"+ext;
            string path=Path.Combine(downloadFolder,candidate);
            if(path.Length>245)throw new Exception("保存路径过长，请重新选择较短的保存目录。");
            if(File.Exists(path)||Directory.Exists(path))continue;
            string hash;
            using(SHA256 sha=SHA256.Create())hash=BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(path.ToUpperInvariant()))).Replace("-","");
            marker=Path.Combine(dir,hash+".lock");
            try {using(FileStream fs=new FileStream(marker,FileMode.CreateNew,FileAccess.Write,FileShare.None)){}return candidate;}
            catch(IOException) {if(!File.Exists(marker))throw;}
        }
        throw new Exception("同名任务过多，请更换文件名或保存目录。");
    }
    static void CheckWritable(string folder) {
        string probe=Path.Combine(folder,".pcl-edge-write-"+Guid.NewGuid().ToString("N")+".tmp");
        using(FileStream file=new FileStream(probe,FileMode.CreateNew,FileAccess.Write,FileShare.None)){}
        File.Delete(probe);
    }
    static string ReadLogTail(string file,long offset) {
        try {
            using(FileStream stream=new FileStream(file,FileMode.Open,FileAccess.Read,FileShare.ReadWrite|FileShare.Delete)) {
                if(stream.Length<offset || stream.Length-offset>2097152)return "";
                stream.Position=offset;
                byte[] bytes=new byte[(int)(stream.Length-offset)];int count=0,n;
                while(count<bytes.Length && (n=stream.Read(bytes,count,bytes.Length-count))>0)count+=n;
                return Encoding.UTF8.GetString(bytes,0,count)+"\n"+Encoding.GetEncoding(936).GetString(bytes,0,count);
            }
        } catch(IOException){return "";}catch(UnauthorizedAccessException){return "";}
    }
    public static int LogEvidence(string text,string name) {
        string marker="自定义下载文件："+name+" ";
        bool began=false,failed=false;
        foreach(string line in text.Split('\n')) {
            if(!line.Contains(marker)||!line.Contains("加载器 ")||!line.Contains(" 状态改变："))continue;
            if(line.Contains("状态改变：Failed")||line.Contains("状态改变：Aborted"))failed=true;
            if(line.Contains("状态改变：Loading")||line.Contains("状态改变：Finished"))began=true;
        }
        return failed?-1:(began?1:0);
    }
    static long Now(){return (long)(DateTime.UtcNow-Epoch).TotalMilliseconds;}
    static void CheckTime(){if(Now()>Deadline)throw new Exception("任务已过期，请重试。");}
    static void Sleep(int ms){CheckTime();Thread.Sleep(ms);CheckTime();}

    public static string ReadFrame(Stream stream) {
        byte[] header=new byte[4];int first=stream.Read(header,0,4);
        if(first==0)return null;
        ReadExact(stream,header,first,4-first);
        uint size=BitConverter.ToUInt32(header,0);
        if(size==0 || size>MaxFrame)throw new InvalidDataException("Invalid message length");
        byte[] bytes=new byte[(int)size];ReadExact(stream,bytes,0,bytes.Length);
        return new UTF8Encoding(false,true).GetString(bytes);
    }
    static void ReadExact(Stream s,byte[] bytes,int offset,int count) {
        while(count>0){int n=s.Read(bytes,offset,count);if(n==0)throw new EndOfStreamException();offset+=n;count-=n;}
    }
    public static void WriteFrame(Stream stream,string json) {
        byte[] bytes=Encoding.UTF8.GetBytes(json);
        if(bytes.Length>MaxFrame)throw new InvalidDataException();
        byte[] length=BitConverter.GetBytes(bytes.Length);stream.Write(length,0,4);stream.Write(bytes,0,bytes.Length);stream.Flush();
    }
    static void SelfTest() {
        if(SafeName("CON.zip")!="_CON.zip" || SafeName("../a?.exe")!=".._a_.exe")throw new Exception();
        if(NormalizeDownloadFolder(@"D:\游戏\下载")!=@"D:\游戏\下载" || NormalizeDownloadFolder(@"D:\")!=@"D:\")throw new Exception();
        if(!NormalizeDownloadFolder(@"\\server\share\downloads").StartsWith(@"\\server\share",StringComparison.OrdinalIgnoreCase))throw new Exception();
        foreach(string invalidFolder in new[]{"", "Downloads", @"D:Downloads", @"\Downloads"}) {
            bool rejectedFolder=false;try{NormalizeDownloadFolder(invalidFolder);}catch{rejectedFolder=true;}if(!rejectedFolder)throw new Exception();
        }
        ValidateUrl("https://example.com/a?b=中文");
        foreach(string invalid in new[]{"file:///c:/a","javascript:alert(1)","https://u:p@example.com/a","https://example.com/\n"}){
            bool rejected=false;try{ValidateUrl(invalid);}catch{rejected=true;}if(!rejected)throw new Exception();
        }
        string line="[Loader] 加载器 LoaderDownload 自定义下载文件：test.zip  状态改变：Loading";
        if(LogEvidence(line,"test.zip")!=1 || LogEvidence(line,"other.zip")!=0 || LogEvidence(line+"\n"+line.Replace("Loading","Failed"),"test.zip")!=-1)throw new Exception();
        using(MemoryStream m=new MemoryStream()){WriteFrame(m,"{\"中文\":true}");m.Position=0;if(ReadFrame(m)!="{\"中文\":true}" || ReadFrame(m)!=null)throw new Exception();}
        bool oversized=false;try{ReadFrame(new MemoryStream(BitConverter.GetBytes(300000)));}catch(InvalidDataException){oversized=true;}if(!oversized)throw new Exception();
    }

    delegate bool EnumWindowsProc(IntPtr h,IntPtr l);
    [StructLayout(LayoutKind.Sequential)]struct POINT{public int X;public int Y;}
    [StructLayout(LayoutKind.Sequential)]struct INPUT{public uint type;public INPUTUNION data;}
    [StructLayout(LayoutKind.Explicit)]struct INPUTUNION{
        [FieldOffset(0)]public MOUSEINPUT mouse;
        [FieldOffset(0)]public KEYBDINPUT keyboard;
    }
    [StructLayout(LayoutKind.Sequential)]struct MOUSEINPUT{public int dx,dy;public uint mouseData,dwFlags,time;public UIntPtr dwExtraInfo;}
    [StructLayout(LayoutKind.Sequential)]struct KEYBDINPUT{public ushort wVk,wScan;public uint dwFlags,time;public UIntPtr dwExtraInfo;}
    [DllImport("user32.dll")]static extern bool EnumWindows(EnumWindowsProc callback,IntPtr lParam);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetWindowText(IntPtr h,StringBuilder text,int max);
    [DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
    [DllImport("user32.dll")]static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")]static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")]static extern bool ShowWindow(IntPtr h,int cmd);
    [DllImport("user32.dll")]static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")]static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]static extern IntPtr GetAncestor(IntPtr h,uint flags);
    [DllImport("user32.dll")]static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")]static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")]static extern bool SetCursorPos(int x,int y);
    [DllImport("user32.dll",SetLastError=true)]static extern uint SendInput(uint count,INPUT[] input,int size);
}
