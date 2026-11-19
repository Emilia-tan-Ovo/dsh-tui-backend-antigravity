param([Parameter(Mandatory)][string]$Launch)
$ErrorActionPreference = 'Stop'
try {
  $config = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Launch)) | ConvertFrom-Json
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class AgyJob {
  [StructLayout(LayoutKind.Sequential)] struct SI {
    public int cb; public IntPtr reserved, desktop, title;
    public int x,y,xsize,ysize,xchars,ychars,fill,flags;
    public short show, reservedSize; public IntPtr reservedBytes, input, output, error;
  }
  [StructLayout(LayoutKind.Sequential)] struct SIX { public SI si; public IntPtr attrs; }
  [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr process, thread; public uint pid, tid; }
  [StructLayout(LayoutKind.Sequential)] struct BasicLimit {
    public long processTime, jobTime; public uint flags; public UIntPtr min, max;
    public uint active; public UIntPtr affinity; public uint priority, scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IO { public ulong r,w,o,rb,wb,ob; }
  [StructLayout(LayoutKind.Sequential)] struct Limits {
    public BasicLimit basic; public IO io; public UIntPtr processMemory, jobMemory, peakProcess, peakJob;
  }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObjectW(IntPtr a, string n);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr j,int c,ref Limits l,int s);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr j,IntPtr p);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcessW(string exe,StringBuilder cmd,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref SIX si,out PI pi);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr t);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr p,uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr p,out uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int n);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool DuplicateHandle(IntPtr sp,IntPtr sh,IntPtr tp,out IntPtr th,uint access,bool inherit,uint options);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr p,int count,int flags,ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr p,uint flags,IntPtr attr,IntPtr value,IntPtr size,IntPtr prev,IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr p);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForMultipleObjects(uint count,IntPtr[] handles,bool all,uint timeout);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  static void Check(bool ok) { if(!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  // CommandLineToArgvW/CRT quoting. No shell interprets this command line.
  static string Quote(string s) {
    var b=new StringBuilder("\""); int slashes=0;
    foreach(char c in s) {
      if(c=='\\') { slashes++; continue; }
      if(c=='\"') b.Append('\\',slashes*2+1).Append(c);
      else b.Append('\\',slashes).Append(c);
      slashes=0;
    }
    return b.Append('\\',slashes*2).Append('"').ToString();
  }
  public static int Run(string exe,string[] args,string cwd,int parentPid) {
    IntPtr job=IntPtr.Zero,parent=IntPtr.Zero,attrs=IntPtr.Zero,list=IntPtr.Zero,desktopPolicy=IntPtr.Zero;
    IntPtr[] std=new IntPtr[3]; PI pi=new PI(); bool started=false;
    try {
      parent=OpenProcess(0x100000,false,parentPid); Check(parent!=IntPtr.Zero);
      job=CreateJobObjectW(IntPtr.Zero,null); Check(job!=IntPtr.Zero);
      var limits=new Limits(); limits.basic.flags=0x2000;
      Check(SetInformationJobObject(job,9,ref limits,Marshal.SizeOf<Limits>()));
      var self=GetCurrentProcess();
      for(int i=0;i<3;i++) Check(DuplicateHandle(self,GetStdHandle(-10-i),self,out std[i],0,true,2));
      IntPtr bytes=IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,2,0,ref bytes);
      attrs=Marshal.AllocHGlobal(bytes); Check(InitializeProcThreadAttributeList(attrs,2,0,ref bytes));
      list=Marshal.AllocHGlobal(IntPtr.Size*3); Marshal.Copy(std,0,list,3);
      Check(UpdateProcThreadAttribute(attrs,0,(IntPtr)0x20002,list,(IntPtr)(IntPtr.Size*3),IntPtr.Zero,IntPtr.Zero));
      // Store/MSIX PowerShell otherwise moves descendants to its app-runtime
      // Job. Keep that process tree in this runtime so our private Job owns it.
      // PROC_THREAD_ATTRIBUTE_DESKTOP_APP_POLICY / DISABLE_PROCESS_TREE.
      desktopPolicy=Marshal.AllocHGlobal(4); Marshal.WriteInt32(desktopPolicy,0x02);
      Check(UpdateProcThreadAttribute(attrs,0,(IntPtr)0x20012,desktopPolicy,(IntPtr)4,IntPtr.Zero,IntPtr.Zero));
      var si=new SIX(); si.si.cb=Marshal.SizeOf<SIX>(); si.attrs=attrs; si.si.flags=0x100;
      si.si.input=std[0]; si.si.output=std[1]; si.si.error=std[2];
      var cmd=new StringBuilder(Quote(exe)); foreach(var arg in args) cmd.Append(' ').Append(Quote(arg));
      Check(CreateProcessW(exe,cmd,IntPtr.Zero,IntPtr.Zero,true,0x80000|0x4|0x8000000,IntPtr.Zero,cwd,ref si,out pi));
      started=true;
      // Assignment failure never runs the child outside our job.
      Check(AssignProcessToJobObject(job,pi.process));
      if(ResumeThread(pi.thread)==0xffffffff) throw new Win32Exception(Marshal.GetLastWin32Error());
      uint result=WaitForMultipleObjects(2,new[]{pi.process,parent},false,0xffffffff);
      if(result==1) return 125;
      Check(result==0); uint code; Check(GetExitCodeProcess(pi.process,out code));
      return unchecked((int)code);
    } finally {
      // Also kills descendants if the root exited first or our parent died.
      if(job!=IntPtr.Zero) CloseHandle(job);
      if(started && pi.process!=IntPtr.Zero) { TerminateProcess(pi.process,125); CloseHandle(pi.process); }
      if(pi.thread!=IntPtr.Zero) CloseHandle(pi.thread);
      foreach(var h in std) if(h!=IntPtr.Zero) CloseHandle(h);
      if(attrs!=IntPtr.Zero) { DeleteProcThreadAttributeList(attrs); Marshal.FreeHGlobal(attrs); }
      if(list!=IntPtr.Zero) Marshal.FreeHGlobal(list);
      if(desktopPolicy!=IntPtr.Zero) Marshal.FreeHGlobal(desktopPolicy);
      if(parent!=IntPtr.Zero) CloseHandle(parent);
    }
  }
}
'@
  exit [AgyJob]::Run([string]$config.executable, [string[]]$config.args, [string]$config.cwd, [int]$config.parentPid)
} catch {
  [Console]::Error.WriteLine("Antigravity Job host: " + $_.Exception.Message)
  exit 126
}
