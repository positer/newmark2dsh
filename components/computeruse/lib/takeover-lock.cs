// One kernel-owned slot per Windows user and mode. No timeout can steal a live slot.
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Threading;

internal static class TakeoverLock {
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    static int release;
    static int Main(string[] args) {
        if(args.Length!=2 || (args[1]!="real" && args[1]!="virtual"))return 2;
        int pid;if(!int.TryParse(args[0],out pid))return 2;
        IntPtr parent=OpenProcess(0x00100000,false,pid);
        if(parent==IntPtr.Zero){Console.WriteLine("parent-unavailable");return 3;}
        try {
            string sid=WindowsIdentity.GetCurrent().User.Value;
            // Global namespace also coordinates DSH instances in separate logon sessions.
            using(var mutex=new Mutex(false,"Global\\NewmarkDSH-CU-"+sid+"-"+args[1])) {
                bool held=false;
                try {
                    try{held=mutex.WaitOne(0);}catch(AbandonedMutexException){held=true;}
                    if(!held){Console.WriteLine("occupied");return 4;}
                    if(WaitForSingleObject(parent,0)!=258){Console.WriteLine("parent-exited");return 3;}
                    var reader=new Thread(delegate(){try{Console.ReadLine();}finally{Interlocked.Exchange(ref release,1);}});
                    reader.IsBackground=true;reader.Start();
                    Console.WriteLine("acquired");Console.Out.Flush();
                    while(Interlocked.CompareExchange(ref release,0,0)==0) {
                        uint state=WaitForSingleObject(parent,100);
                        if(state!=258)break;
                    }
                    return 0;
                } finally {if(held)mutex.ReleaseMutex();}
            }
        } catch(Exception ex){Console.Error.WriteLine(ex.GetType().Name+": "+ex.Message);return 5;}
        finally {CloseHandle(parent);}
    }
}
