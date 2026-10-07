/**
 * A resident agent that lives ON a hidden Windows desktop and performs every action itself.
 *
 * =====================================================================================
 * THE SHAPE, AND WHAT IT WORKS AROUND RATHER THAN SOLVES
 * =====================================================================================
 *
 * Three phases tried to give a lane reach INTO a hidden desktop and all three came back
 * negative. The mechanism is understood: the kernel answers `IsWindow` and
 * `GetWindowThreadProcessId` for another desktop's window only while the CALLING PROCESS has
 * that desktop open, and the reach dies when the handle closes. A lane on the interactive
 * desktop that opens a hidden desktop, reads it, and closes it therefore cannot be made to
 * work by trying harder.
 *
 * This module does not try. Reach is a property of the calling process, so the caller is put
 * ON that desktop: the agent below is an ordinary process on the hidden desktop, it opens
 * windows there with no cross-desktop call at all, and it holds its own desktop handle for
 * its whole life. No `OpenDesktopW` from the lane, no `AttachThreadInput` across desktops, no
 * cross-desktop `PrintWindow`. If a caller finds that the lane-side reach is needed after
 * all, that is a finding this module contradicts and it should be reported as such.
 *
 * =====================================================================================
 * TWO C# TYPES, AND WHY THEY STAY TWO
 * =====================================================================================
 *
 * A previous phase measured that a desktop MAKER and a process LAUNCHER compiled into ONE
 * C# type produce a child that dies before its first instruction, while the identical calls
 * split across TWO types run. That is not explained here and it is not fixed here; it is
 * honoured. `MAKER_CSHARP` and `LAUNCHER_CSHARP` are separate types, compiled by separate
 * `Add-Type` calls into separate assemblies, and neither one names the other's entry point.
 * The agent's own desktop handle and its process launcher are separated the same way
 * (`NmAgentDesktop` and `NmAgentProcess`).
 *
 * =====================================================================================
 * OWNERSHIP: THE JOB OBJECT IS THE CREDENTIAL
 * =====================================================================================
 *
 * The requirement is that the desktop hold a credential for the applications it carries, and
 * stop and release them immediately if it exits unexpectedly. A `finally` does not do that: it
 * does not run when a process is killed or faults. A Job Object with
 * `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` does, because the kernel terminates every member when
 * the last handle to the job closes - and the handle closes on TerminateProcess, on a fault,
 * and on machine shutdown alike.
 *
 * So the agent creates the job, sets the limit, and ASSIGNS ITSELF to it. Every process it
 * launches afterwards is a member by inheritance, so the whole tree comes in - which is what
 * makes an Edge launch meaningful, since the browser process Edge returns is not the process
 * that renders anything. Holding the job handle IS ownership; there is no separate bookkeeping
 * step that could be forgotten.
 *
 * `CloseDesktop` and killing processes are different things and this module keeps them apart:
 * `op: "close_desktop"` closes the desktop hold and reports what that did, `op: "exit"` closes
 * the job handle and reports what that did. The two are measured separately.
 *
 * =====================================================================================
 * THE LEDGER
 * =====================================================================================
 *
 * A job handle cannot survive a machine that was never asked to close it politely, and it
 * cannot reach a process that broke away from the job. So every hosted process is also
 * recorded under this component's own root - desktop name, pid AND the process start time -
 * and the next start reaps what is still alive. The start time is the whole point: a pid
 * alone is reused, and a reaper that trusts a pid eventually kills something that is not its
 * own. `NmProcessFacts.TerminateIfStartTime` refuses when the start time does not match.
 *
 * =====================================================================================
 * WHAT THIS FILE DELIBERATELY DOES NOT DO
 * =====================================================================================
 *
 *   - It names no process class, anywhere, ever. Every process it starts is tracked by the
 *     pid its own create call returned.
 *   - It imports nothing from `lib/win32.js` at load time and spawns nothing at load time.
 *     The lane relay below reaches the lane through a dynamic `import` inside the function
 *     that needs it, so merely importing this module starts no process and opens no desktop.
 *   - It writes nothing under the Newmark root. Its runtime state is under this component's
 *     own `.runtime` directory and its captures go wherever the caller asks for them.
 */

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** This component's own directory - the plugin root the ledger lives under. */
export const COMPONENT_DIR = path.resolve(HERE, '..');

/** Where the ledger and the agent's script payloads live. Never the Newmark root. */
export function runtimeRoot() {
  return path.join(COMPONENT_DIR, '.runtime');
}

export function ledgerPath() {
  return path.join(runtimeRoot(), 'hidden-agent-ledger.jsonl');
}

/**
 * Windows PowerShell 5.1, named explicitly.
 *
 * The agent and the desktop launcher are compiled by `Add-Type`, and on 5.1 that is the C#
 * 5 compiler - the same one the lane falls back to. Running the desktop-side payloads under
 * 5.1 rather than `pwsh` makes the dialect constraint a thing this code is measured against
 * rather than a thing it is written to satisfy on trust. `pwsh` is not required to exist for
 * a hidden desktop to work.
 */
export function windowsPowerShellPath() {
  const root = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/* ===================================================================================== *
 * the C# payloads
 *
 * Every one of these is in the measured dialect (see `lib/csharp-dialect.js`): no
 * interpolated strings, no lambdas, no nameof, no out-var, no tuples, no null-conditional,
 * no using static, and no System.Drawing type name. None of them contains a backtick, which
 * is what would terminate the template literal it lives in - a previous phase lost a lane to
 * a backtick inside a C# doc comment.
 * ===================================================================================== */

/* #nm-csharp-begin maker */
/**
 * The desktop MAKER. It creates and opens desktops and it never names CreateProcessW.
 */
export const MAKER_CSHARP = String.raw`using System;
using System.Runtime.InteropServices;
using System.Text;

/**
 * The desktop maker, and nothing else.
 *
 * This type is compiled by its own Add-Type call into its own assembly, and it does not
 * declare CreateProcessW. A previous phase measured that the maker and the launcher compiled
 * into ONE type give a child that dies before its first instruction, while the identical
 * calls in TWO types run. The two halves of a desktop launch therefore stay in two types.
 *
 * The name and device parameters are raw pointers rather than strings. PowerShell converts
 * both a null and an empty string at a string parameter into an empty BSTR rather than a
 * NULL pointer, so a string device parameter that the caller leaves null makes CreateDesktopW
 * answer ERROR_INVALID_PARAMETER (87): it creates nothing, it throws nothing, and every later
 * step quietly runs against the caller's own desktop. Marshalling the pointer here removes
 * the possibility instead of documenting it.
 */
public static class NmHiddenMaker
{
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern IntPtr CreateDesktopW(IntPtr name, IntPtr device, IntPtr devmode, int flags, uint access, IntPtr sa);

  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern IntPtr OpenDesktopW(string name, int flags, bool inherit, uint access);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool CloseDesktop(IntPtr desktop);

  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern int GetUserObjectInformationW(IntPtr handle, int index, StringBuilder info, int length, out int needed);

  [DllImport("user32.dll")]
  public static extern IntPtr GetThreadDesktop(uint threadId);

  [DllImport("user32.dll")]
  public static extern IntPtr GetProcessWindowStation();

  [DllImport("kernel32.dll")]
  public static extern uint GetCurrentThreadId();

  public const int UOI_NAME = 2;
  public const uint GENERIC_ALL = 0x10000000;
  public const uint DESKTOP_ALL_ACCESS = 0x000F01FF;

  public static string KernelName(IntPtr handle)
  {
    StringBuilder buffer = new StringBuilder(512);
    int needed;
    if (GetUserObjectInformationW(handle, UOI_NAME, buffer, buffer.Capacity * 2, out needed) == 0) return "";
    return buffer.ToString();
  }

  public static string DesktopName()
  {
    return KernelName(GetThreadDesktop(GetCurrentThreadId()));
  }

  public static string WindowStationName()
  {
    return KernelName(GetProcessWindowStation());
  }

  public static IntPtr CreateByName(string name, out int error)
  {
    IntPtr namePointer = Marshal.StringToHGlobalUni(name);
    IntPtr desktop = CreateDesktopW(namePointer, IntPtr.Zero, IntPtr.Zero, 0, GENERIC_ALL, IntPtr.Zero);
    /* The error is only meaningful when the call FAILED. Reading Marshal.GetLastWin32Error after a
       SUCCESSFUL call reports whatever the previous failing call left behind - this reported 203 on
       every healthy open, which reads exactly like a fault and is not one. */
    if (desktop == IntPtr.Zero) error = Marshal.GetLastWin32Error(); else error = 0;
    Marshal.FreeHGlobal(namePointer);
    return desktop;
  }

  public static IntPtr OpenByName(string name, out int error)
  {
    IntPtr desktop = OpenDesktopW(name, 0, false, DESKTOP_ALL_ACCESS);
    if (desktop == IntPtr.Zero) error = Marshal.GetLastWin32Error(); else error = 0;
    return desktop;
  }
}
`;
/* #nm-csharp-end maker */

/* #nm-csharp-begin launcher */
/**
 * The process LAUNCHER. It starts a process onto a named desktop and never creates one.
 */
export const LAUNCHER_CSHARP = String.raw`using System;
using System.Runtime.InteropServices;

/**
 * The process launcher, and nothing else.
 *
 * It creates no desktop and holds no desktop handle: the two halves of a desktop launch are
 * two types because that is the arrangement a previous phase measured to work.
 *
 * Configuration is passed on the COMMAND LINE and never through the environment. The same
 * call, the same lpDesktop and the same command line were measured to give a child that dies
 * before its first instruction (0xC0000142 native, 0x8007008A managed) when the configuration
 * travelled as an environment variable written with SetEnvironmentVariableW and the child was
 * given a null environment block with CREATE_UNICODE_ENVIRONMENT. The block is therefore
 * inherited - never built here - and paths with spaces are quoted on the command line.
 */
public static class NmHiddenLauncher
{
  [StructLayout(LayoutKind.Sequential)]
  public struct STARTUPINFO
  {
    public int cb; public IntPtr lpReserved; public IntPtr lpDesktop; public IntPtr lpTitle;
    public int dwX; public int dwY; public int dwXSize; public int dwYSize; public int dwXCountChars;
    public int dwYCountChars; public int dwFillAttribute; public int dwFlags;
    public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2;
    public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_INFORMATION
  {
    public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId;
  }

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern IntPtr CreateProcessW(IntPtr application, IntPtr commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, IntPtr currentDirectory, ref STARTUPINFO startupInfo, out PROCESS_INFORMATION processInformation);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool CloseHandle(IntPtr handle);

  public const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;

  public static int Launch(string desktopName, string commandLine, out int error)
  {
    STARTUPINFO info = new STARTUPINFO();
    info.cb = Marshal.SizeOf(typeof(STARTUPINFO));
    IntPtr desktopPointer = Marshal.StringToHGlobalUni(desktopName);
    IntPtr commandPointer = Marshal.StringToHGlobalUni(commandLine);
    PROCESS_INFORMATION process = new PROCESS_INFORMATION();
    bool started = false;
    try
    {
      info.lpDesktop = desktopPointer;
      /* The environment block is IntPtr.Zero, which means INHERIT. It is never built and no
         variable is ever set for the child: that path was measured to kill the child before
         its first instruction. CREATE_UNICODE_ENVIRONMENT is harmless with an inherited
         block and is kept so this is the same call that was measured to work. */
      started = CreateProcessW(IntPtr.Zero, commandPointer, IntPtr.Zero, IntPtr.Zero, false, CREATE_UNICODE_ENVIRONMENT, IntPtr.Zero, IntPtr.Zero, ref info, out process) != IntPtr.Zero;
      error = Marshal.GetLastWin32Error();
    }
    finally
    {
      Marshal.FreeHGlobal(desktopPointer);
      Marshal.FreeHGlobal(commandPointer);
    }
    if (!started) return 0;
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    return process.dwProcessId;
  }
}
`;
/* #nm-csharp-end launcher */

/* #nm-csharp-begin facts */
/**
 * Read-only process facts, and the one write this module ever makes to another process.
 *
 * The same source is compiled in the agent and in the harness, deliberately: a reaper that
 * validates a pid with different code from the code that recorded it is not validating it.
 */
export const PROCESS_FACTS_CSHARP = String.raw`using System;
using System.Runtime.InteropServices;
using System.Text;

/**
 * Process identity, by pid AND start time.
 *
 * A pid on its own is not an identity: Windows reuses it, and a ledger that stores a bare pid
 * will one day terminate a process that merely inherited the number. Every read here answers
 * with the creation time as well, and the terminate refuses when it does not match.
 */
public static class NmProcessFacts
{
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
  public static void WatchOwner(int pid) {
    IntPtr owner = OpenProcess(0x100000, false, pid);
    if(owner == IntPtr.Zero) Environment.Exit(0);
    var watcher = new System.Threading.Thread(new System.Threading.ThreadStart(delegate {
      try { WaitForSingleObject(owner, 0xffffffff); Environment.Exit(0); }
      finally { CloseHandle(owner); }
    }));
    watcher.IsBackground = true; watcher.Start();
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct FILETIME { public uint Low; public uint High; }

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool GetProcessTimes(IntPtr handle, out FILETIME creation, out FILETIME exit, out FILETIME kernel, out FILETIME user);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool TerminateProcess(IntPtr handle, uint exitCode);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool CloseHandle(IntPtr handle);

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool QueryFullProcessImageNameW(IntPtr handle, uint flags, StringBuilder name, ref int size);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool GetExitCodeProcess(IntPtr handle, out uint exitCode);

  public const uint PROCESS_TERMINATE = 0x0001;
  public const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
  public const uint STILL_ACTIVE = 259;

  /**
   * Is this pid a process that is still RUNNING?
   *
   * This is not the same question as "does OpenProcess succeed", and the difference is the whole
   * reason this method exists. Measured on this machine: after TerminateProcess returns success, the
   * pid keeps answering OpenProcess and GetProcessTimes for SECONDS - a terminated process stays in
   * the pid table until the kernel reaps it - so a liveness test built on OpenProcess reports a
   * corpse as alive, and a measurement built on that test reports its own successful kill as a
   * failure. A process is alive when its exit code is STILL_ACTIVE and not before.
   */
  public static bool Running(int pid)
  {
    IntPtr handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if (handle == IntPtr.Zero) return false;
    try
    {
      uint exitCode;
      if (!GetExitCodeProcess(handle, out exitCode)) return false;
      return exitCode == STILL_ACTIVE;
    }
    finally { CloseHandle(handle); }
  }

  public static long StartTimeTicks(int pid)
  {
    IntPtr handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if (handle == IntPtr.Zero) return 0;
    try
    {
      FILETIME creation; FILETIME exit; FILETIME kernel; FILETIME user;
      if (!GetProcessTimes(handle, out creation, out exit, out kernel, out user)) return 0;
      return ((long)creation.High << 32) | (long)creation.Low;
    }
    finally { CloseHandle(handle); }
  }

  public static string StartTimeUtc(int pid)
  {
    long ticks = StartTimeTicks(pid);
    if (ticks <= 0) return "";
    try { return DateTime.FromFileTimeUtc(ticks).ToString("o"); }
    catch (Exception) { return ""; }
  }

  public static bool Alive(int pid, long expectedTicks)
  {
    if (!Running(pid)) return false;
    long ticks = StartTimeTicks(pid);
    if (ticks <= 0) return false;
    if (expectedTicks <= 0) return true;
    return ticks == expectedTicks;
  }

  public static string ImagePath(int pid)
  {
    IntPtr handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if (handle == IntPtr.Zero) return "";
    try
    {
      StringBuilder buffer = new StringBuilder(1024);
      int size = buffer.Capacity;
      if (!QueryFullProcessImageNameW(handle, 0, buffer, ref size)) return "";
      return buffer.ToString();
    }
    finally { CloseHandle(handle); }
  }

  /**
   * Terminate ONLY the process whose creation time matches.
   *
   * Returns 1 when it terminated, 0 when the process was already gone, -1 when the pid is
   * alive but is a DIFFERENT process (reuse), and -2 when the handle or the call failed. A
   * caller can therefore tell "already gone" from "not mine" without guessing.
   */
  public static int TerminateIfStartTime(int pid, long expectedTicks, out int error)
  {
    error = 0;
    /* Already gone is reported as ALREADY GONE and not as a failure. A terminated process keeps
       answering OpenProcess for seconds, so without this check a reaper that ran twice would report
       the second run as a run of failures (-2, "TerminateProcess refused") when in fact there was
       nothing left to do. */
    if (!Running(pid)) return 0;
    IntPtr handle = OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if (handle == IntPtr.Zero) { error = Marshal.GetLastWin32Error(); return 0; }
    try
    {
      FILETIME creation; FILETIME exit; FILETIME kernel; FILETIME user;
      if (!GetProcessTimes(handle, out creation, out exit, out kernel, out user)) { error = Marshal.GetLastWin32Error(); return -2; }
      long observed = ((long)creation.High << 32) | (long)creation.Low;
      if (expectedTicks > 0 && observed != expectedTicks) { error = 0; return -1; }
      if (!TerminateProcess(handle, 1)) { error = Marshal.GetLastWin32Error(); return -2; }
      return 1;
    }
    finally { CloseHandle(handle); }
  }
}
`;
/* #nm-csharp-end facts */

/* #nm-csharp-begin agent-desktop */
/**
 * The AGENT's own hold on its own desktop. Separate from the maker on purpose: a process that
 * lives on a desktop and a process that creates one are different jobs, and the one thing
 * measured about compiling them together was that it breaks.
 */
export const AGENT_DESKTOP_CSHARP = String.raw`using System;
using System.Runtime.InteropServices;
using System.Text;

/**
 * The agent own desktop handle, held for the agent whole life.
 *
 * The agent is STARTED onto the desktop, so it does not need this handle to see that desktop:
 * it needs the handle to KEEP the desktop alive. A desktop dies when its last handle closes,
 * silently and completely - so a holder is not a convenience, it is the thing that decides
 * whether the desktop exists at all. When this process is killed the handle closes with it and
 * the desktop goes with the handle, which is the lifetime this module wants.
 */
public static class NmAgentDesktop
{
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern IntPtr OpenDesktopW(string name, int flags, bool inherit, uint access);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool CloseDesktop(IntPtr desktop);

  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern int GetUserObjectInformationW(IntPtr handle, int index, StringBuilder info, int length, out int needed);

  [DllImport("user32.dll")]
  public static extern IntPtr GetThreadDesktop(uint threadId);

  [DllImport("user32.dll")]
  public static extern IntPtr GetProcessWindowStation();

  [DllImport("kernel32.dll")]
  public static extern uint GetCurrentThreadId();

  public const int UOI_NAME = 2;
  public const uint DESKTOP_ALL_ACCESS = 0x000F01FF;

  public static string KernelName(IntPtr handle)
  {
    StringBuilder buffer = new StringBuilder(512);
    int needed;
    if (GetUserObjectInformationW(handle, UOI_NAME, buffer, buffer.Capacity * 2, out needed) == 0) return "";
    return buffer.ToString();
  }

  public static string ThreadDesktopName()
  {
    return KernelName(GetThreadDesktop(GetCurrentThreadId()));
  }

  public static string WindowStationName()
  {
    return KernelName(GetProcessWindowStation());
  }

  public static string HoldName(IntPtr hold)
  {
    return KernelName(hold);
  }

  public static IntPtr OpenByName(string name, out int error)
  {
    IntPtr desktop = OpenDesktopW(name, 0, false, DESKTOP_ALL_ACCESS);
    /* Only meaningful when the call FAILED: after a successful open this reported whatever the
       previous failing call left behind (203, every time), which reads like a fault and is not one. */
    if (desktop == IntPtr.Zero) error = Marshal.GetLastWin32Error(); else error = 0;
    return desktop;
  }

  public static bool Close(IntPtr hold)
  {
    return CloseDesktop(hold);
  }
}
`;
/* #nm-csharp-end agent-desktop */

/* #nm-csharp-begin agent-job */
/**
 * The credential: a job object with KILL_ON_JOB_CLOSE, and the membership read that proves
 * the whole tree came in rather than only the process the launcher returned.
 */
export const AGENT_JOB_CSHARP = String.raw`using System;
using System.Runtime.InteropServices;

/**
 * Ownership, as a kernel object.
 *
 * JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE is the whole mechanism: when the last handle to this job
 * closes, the kernel terminates every member. It fires on TerminateProcess, on an access
 * violation, on a machine that is being reset, and on the parent exiting normally - none of
 * which a finally block survives. Holding the handle IS ownership.
 *
 * The agent assigns ITSELF before it launches anything, so every child arrives in the job by
 * inheritance and a tree is covered without the launcher having to name each process. That is
 * the difference between holding an app and holding the browser process an app happens to
 * return while the renderers run outside it.
 */
public static class NmAgentJob
{
  [StructLayout(LayoutKind.Sequential)]
  public struct JOBOBJECT_BASIC_LIMIT_INFORMATION
  {
    public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit; public UIntPtr Affinity;
    public uint PriorityClass; public uint SchedulingClass;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct IO_COUNTERS
  {
    public ulong ReadOperationCount; public ulong WriteOperationCount; public ulong OtherOperationCount;
    public ulong ReadTransferCount; public ulong WriteTransferCount; public ulong OtherTransferCount;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
  {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
    public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed;
  }

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool QueryInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length, out uint returned);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool TerminateJobObject(IntPtr job, uint exitCode);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern IntPtr GetCurrentProcess();

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool CloseHandle(IntPtr handle);

  public const int JobObjectExtendedLimitInformation = 9;
  public const int JobObjectBasicProcessIdList = 3;
  public const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
  public const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
  public const uint PROCESS_SET_QUOTA = 0x0100;
  public const uint PROCESS_TERMINATE = 0x0001;

  public static IntPtr CreateKillOnClose(out int error)
  {
    error = 0;
    IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
    if (job == IntPtr.Zero) { error = Marshal.GetLastWin32Error(); return IntPtr.Zero; }
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
    IntPtr buffer = Marshal.AllocHGlobal(size);
    bool applied = false;
    try
    {
      Marshal.StructureToPtr(limits, buffer, false);
      applied = SetInformationJobObject(job, JobObjectExtendedLimitInformation, buffer, (uint)size);
      error = Marshal.GetLastWin32Error();
    }
    finally { Marshal.FreeHGlobal(buffer); }
    if (!applied) { CloseHandle(job); return IntPtr.Zero; }
    return job;
  }

  public static bool AssignSelf(IntPtr job, out int error)
  {
    bool assigned = AssignProcessToJobObject(job, GetCurrentProcess());
    error = Marshal.GetLastWin32Error();
    return assigned;
  }

  public static bool SelfInJob(IntPtr job)
  {
    bool result = false;
    IsProcessInJob(GetCurrentProcess(), job, out result);
    return result;
  }

  public static bool PidInJob(int pid, IntPtr job)
  {
    IntPtr handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if (handle == IntPtr.Zero) return false;
    try
    {
      bool result = false;
      IsProcessInJob(handle, job, out result);
      return result;
    }
    finally { CloseHandle(handle); }
  }

  public static uint LimitFlags(IntPtr job, out int error)
  {
    error = 0;
    int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
    IntPtr buffer = Marshal.AllocHGlobal(size);
    try
    {
      uint returned;
      if (!QueryInformationJobObject(job, JobObjectExtendedLimitInformation, buffer, (uint)size, out returned))
      {
        error = Marshal.GetLastWin32Error();
        return 0;
      }
      JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = (JOBOBJECT_EXTENDED_LIMIT_INFORMATION)Marshal.PtrToStructure(buffer, typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
      return limits.BasicLimitInformation.LimitFlags;
    }
    finally { Marshal.FreeHGlobal(buffer); }
  }

  /**
   * Every pid in the job, and how many the kernel says are assigned.
   *
   * Both numbers are returned because they can disagree: when the buffer is too small the
   * kernel reports more assigned processes than it listed, and a caller that only read the
   * list would believe a partial answer was the whole tree.
   */
  public static int[] MemberPids(IntPtr job, out int error, out int assigned)
  {
    error = 0;
    assigned = 0;
    int capacity = 65536;
    IntPtr buffer = Marshal.AllocHGlobal(capacity);
    try
    {
      uint returned;
      bool answered = QueryInformationJobObject(job, JobObjectBasicProcessIdList, buffer, (uint)capacity, out returned);
      /* ERROR_MORE_DATA (234) means the buffer was too small: the call reports failure but the
         two counts are filled in, so they are read anyway and the disagreement between them is
         what tells the caller the list is partial. */
      if (!answered)
      {
        error = Marshal.GetLastWin32Error();
        if (error != 234) return new int[0];
      }
      assigned = Marshal.ReadInt32(buffer, 0);
      int listed = Marshal.ReadInt32(buffer, 4);
      int room = (capacity - 8) / IntPtr.Size;
      if (listed > room) listed = room;
      int[] pids = new int[listed];
      for (int i = 0; i < listed; i++) pids[i] = Marshal.ReadInt32(buffer, 8 + (i * IntPtr.Size));
      return pids;
    }
    finally { Marshal.FreeHGlobal(buffer); }
  }

  public static bool Terminate(IntPtr job, out int error)
  {
    bool terminated = TerminateJobObject(job, 1);
    error = Marshal.GetLastWin32Error();
    return terminated;
  }

  /**
   * Membership as a THREE-VALUED answer, because "false" alone cannot be told from a failure.
   *
   * The shipped read was PidInJob, which answers "false" both when the process is genuinely
   * not a member AND when OpenProcess refused the handle - so a read that never happened was
   * reported as the fact "this process is not in the job". Measured on this station: a launched
   * application was reported in_job false while the agent that launched it reported
   * job_in_job true, and nothing in the receipt said which of the two readings it was.
   *
   *   1 the process is a member of this job
   *   0 the handle opened and the process is NOT a member
   *  -1 the handle could not be opened, and the error code says why
   */
  public static int PidMembership(IntPtr job, int pid, out int error)
  {
    error = 0;
    IntPtr handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if (handle == IntPtr.Zero) { error = Marshal.GetLastWin32Error(); return -1; }
    try
    {
      bool result = false;
      if (!IsProcessInJob(handle, job, out result)) { error = Marshal.GetLastWin32Error(); return -1; }
      return result ? 1 : 0;
    }
    finally { CloseHandle(handle); }
  }

  /**
   * Put a pid in this job AFTER it was created, and answer what happened.
   *
   * Inheritance is the mechanism that is supposed to make this unnecessary, and it is not
   * sufficient: a launch that hands its work to a process this agent did not create - which is
   * what happens when the target is a packaged application - arrives OUTSIDE the job, and a
   * process outside the job is not killed by KILL_ON_JOB_CLOSE. Holding it is therefore done in
   * two steps and the second one is measured, never assumed.
   *
   * AssignProcessToJobObject needs PROCESS_SET_QUOTA and PROCESS_TERMINATE, which is why this
   * opens its own handle rather than reusing a query-only one. A refusal (typically
   * ERROR_ACCESS_DENIED, 5, when the process already belongs to a job this one cannot nest
   * with) is returned as a failure with its error code, and the caller reports the launch as
   * NOT held rather than silently absent.
   */
  public static bool AssignPid(IntPtr job, int pid, out int error)
  {
    error = 0;
    IntPtr handle = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if (handle == IntPtr.Zero) { error = Marshal.GetLastWin32Error(); return false; }
    try
    {
      bool assigned = AssignProcessToJobObject(job, handle);
      error = Marshal.GetLastWin32Error();
      return assigned;
    }
    finally { CloseHandle(handle); }
  }

  public static bool Release(IntPtr job)
  {
    return CloseHandle(job);
  }
}
`;
/* #nm-csharp-end agent-job */

/* #nm-csharp-begin agent-process */
/**
 * The AGENT's launcher. It starts the application onto the agent's OWN desktop, by name, and
 * never creates a desktop.
 */
export const AGENT_PROCESS_CSHARP = String.raw`using System;
using System.Runtime.InteropServices;

/**
 * Start a process onto a named desktop, from a process that is already on it.
 *
 * The desktop name is passed explicitly rather than left to inheritance. A null lpDesktop
 * does mean "the parent desktop" for a console child, but the whole point of this module is
 * that the landing desktop is a measured fact rather than an assumption, so the name travels
 * on this call and the agent reports what it asked for and what it got.
 */
public static class NmAgentProcess
{
  [StructLayout(LayoutKind.Sequential)]
  public struct STARTUPINFO
  {
    public int cb; public IntPtr lpReserved; public IntPtr lpDesktop; public IntPtr lpTitle;
    public int dwX; public int dwY; public int dwXSize; public int dwYSize; public int dwXCountChars;
    public int dwYCountChars; public int dwFillAttribute; public int dwFlags;
    public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2;
    public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_INFORMATION
  {
    public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId;
  }

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern IntPtr CreateProcessW(IntPtr application, IntPtr commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, IntPtr currentDirectory, ref STARTUPINFO startupInfo, out PROCESS_INFORMATION processInformation);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool CloseHandle(IntPtr handle);

  public const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;

  public static int LaunchOn(string desktopName, string commandLine, out int error)
  {
    STARTUPINFO info = new STARTUPINFO();
    info.cb = Marshal.SizeOf(typeof(STARTUPINFO));
    IntPtr desktopPointer = Marshal.StringToHGlobalUni(desktopName);
    IntPtr commandPointer = Marshal.StringToHGlobalUni(commandLine);
    PROCESS_INFORMATION process = new PROCESS_INFORMATION();
    bool started = false;
    try
    {
      info.lpDesktop = desktopPointer;
      /* The environment block stays IntPtr.Zero: the child inherits the agent own block and
         no variable is ever set for it. Building a block and passing it with
         CREATE_UNICODE_ENVIRONMENT was measured in an earlier phase to kill the child before
         its first instruction, so configuration travels on the command line instead. */
      started = CreateProcessW(IntPtr.Zero, commandPointer, IntPtr.Zero, IntPtr.Zero, false, CREATE_UNICODE_ENVIRONMENT, IntPtr.Zero, IntPtr.Zero, ref info, out process) != IntPtr.Zero;
      error = Marshal.GetLastWin32Error();
    }
    finally
    {
      Marshal.FreeHGlobal(desktopPointer);
      Marshal.FreeHGlobal(commandPointer);
    }
    if (!started) return 0;
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    return process.dwProcessId;
  }
}
`;
/* #nm-csharp-end agent-process */

/* #nm-csharp-begin agent-window */
/**
 * The window surface, driven from a process that is already on the target desktop.
 *
 * Everything here is an ordinary same-desktop call. Capture returns raw DIB bits and this type
 * writes the BMP itself, because Add-Type gives the compiler no System.Drawing reference and
 * naming such a type fails with CS1069 (lib/win32.js:985-988).
 */
export const AGENT_WINDOW_CSHARP = String.raw`using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

/**
 * Windows on the calling thread desktop, and the four acts the agent performs on them.
 *
 * EnumWindows enumerates the top-level windows of the desktop the CALLING THREAD is attached
 * to, which is exactly the reach this module is built on: no desktop handle is passed in,
 * because the process is already on the desktop it is listing.
 *
 * Input is posted, not injected. A hidden desktop can never be the input desktop, so SendInput
 * has nothing to aim at there; PostMessage puts the message in the target window queue and the
 * window own message loop dispatches it. That is the mechanism that makes a hidden desktop
 * drivable at all, and it is why the same code drives the same application on the interactive
 * desktop without moving the real pointer.
 */
public static class NmAgentWindow
{
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X; public int Y; }

  [StructLayout(LayoutKind.Sequential)]
  public struct BITMAPINFOHEADER
  {
    public uint biSize; public int biWidth; public int biHeight;
    public ushort biPlanes; public ushort biBitCount; public uint biCompression;
    public uint biSizeImage; public int biXPelsPerMeter; public int biYPelsPerMeter;
    public uint biClrUsed; public uint biClrImportant;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct BITMAPINFO
  {
    public BITMAPINFOHEADER bmiHeader; public uint bmiColors0;
  }

  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")]
  public static extern bool EnumWindows(EnumProc callback, IntPtr lParam);

  [DllImport("user32.dll")]
  public static extern bool EnumChildWindows(IntPtr parent, EnumProc callback, IntPtr lParam);

  [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetWindowTextW")]
  public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int maxCount);

  [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetClassNameW")]
  public static extern int GetClassNameW(IntPtr hWnd, StringBuilder text, int maxCount);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool GetClientRect(IntPtr hWnd, out RECT rect);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool ClientToScreen(IntPtr hWnd, ref POINT point);

  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

  [DllImport("user32.dll")]
  public static extern bool IsWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool IsIconic(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool PostMessageW(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern IntPtr SendMessageW(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);

  [DllImport("user32.dll")]
  public static extern IntPtr GetWindowDC(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern int ReleaseDC(IntPtr hWnd, IntPtr hdc);

  [DllImport("gdi32.dll")]
  public static extern IntPtr CreateCompatibleDC(IntPtr hdc);

  [DllImport("gdi32.dll")]
  public static extern IntPtr CreateCompatibleBitmap(IntPtr hdc, int width, int height);

  [DllImport("gdi32.dll")]
  public static extern IntPtr SelectObject(IntPtr hdc, IntPtr handle);

  [DllImport("gdi32.dll")]
  public static extern bool DeleteObject(IntPtr handle);

  [DllImport("gdi32.dll")]
  public static extern bool DeleteDC(IntPtr hdc);

  [DllImport("user32.dll")]
  public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);

  [DllImport("gdi32.dll")]
  public static extern bool BitBlt(IntPtr destination, int x, int y, int width, int height, IntPtr source, int sourceX, int sourceY, uint rop);

  [DllImport("gdi32.dll")]
  public static extern int GetDIBits(IntPtr hdc, IntPtr bitmap, uint start, uint lines, byte[] bits, ref BITMAPINFO info, uint usage);

  public const uint WM_MOUSEMOVE = 0x0200;
  public const uint WM_LBUTTONDOWN = 0x0201;
  public const uint WM_LBUTTONUP = 0x0202;
  public const uint WM_KEYDOWN = 0x0100;
  public const uint WM_KEYUP = 0x0101;
  public const uint WM_CHAR = 0x0102;
  public const uint WM_MOUSEWHEEL = 0x020A;
  public const uint SRCCOPY = 0x00CC0020;

  public sealed class WindowFact
  {
    public long Handle { get; set; }
    public string Title { get; set; }
    public string ClassName { get; set; }
    public int ProcessId { get; set; }
    public int ThreadId { get; set; }
    public int Left { get; set; }
    public int Top { get; set; }
    public int Right { get; set; }
    public int Bottom { get; set; }
    public int ClientWidth { get; set; }
    public int ClientHeight { get; set; }
    public bool Visible { get; set; }
    public bool Minimized { get; set; }
  }

  public static WindowFact One(IntPtr hWnd)
  {
    RECT rect;
    RECT client;
    if (!GetWindowRect(hWnd, out rect)) return null;
    if (!GetClientRect(hWnd, out client)) { client.Left = 0; client.Top = 0; client.Right = 0; client.Bottom = 0; }
    WindowFact fact = new WindowFact();
    fact.Handle = hWnd.ToInt64();
    StringBuilder className = new StringBuilder(512);
    GetClassNameW(hWnd, className, className.Capacity);
    fact.ClassName = className.ToString();
    StringBuilder title = new StringBuilder(2048);
    GetWindowTextW(hWnd, title, title.Capacity);
    fact.Title = title.ToString();
    uint processId;
    uint threadId = GetWindowThreadProcessId(hWnd, out processId);
    fact.ProcessId = (int)processId;
    fact.ThreadId = (int)threadId;
    fact.Left = rect.Left; fact.Top = rect.Top; fact.Right = rect.Right; fact.Bottom = rect.Bottom;
    fact.ClientWidth = client.Right - client.Left;
    fact.ClientHeight = client.Bottom - client.Top;
    fact.Visible = IsWindowVisible(hWnd);
    fact.Minimized = IsIconic(hWnd);
    return fact;
  }

  public static WindowFact[] TopLevelWindows()
  {
    List<WindowFact> results = new List<WindowFact>();
    EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
    {
      try
      {
        WindowFact fact = One(hWnd);
        if (fact != null) results.Add(fact);
      }
      catch (Exception) { }
      return true;
    }, IntPtr.Zero);
    return results.ToArray();
  }

  public static WindowFact[] ChildWindows(IntPtr parent)
  {
    List<WindowFact> results = new List<WindowFact>();
    EnumChildWindows(parent, delegate(IntPtr hWnd, IntPtr lParam)
    {
      try
      {
        WindowFact fact = One(hWnd);
        if (fact != null) results.Add(fact);
      }
      catch (Exception) { }
      return true;
    }, IntPtr.Zero);
    return results.ToArray();
  }

  /** The first descendant whose class name contains EDIT, which is where typing lands. */
  public static IntPtr FindEditChild(IntPtr parent)
  {
    IntPtr found = IntPtr.Zero;
    EnumChildWindows(parent, delegate(IntPtr hWnd, IntPtr lParam)
    {
      if (found != IntPtr.Zero) return false;
      StringBuilder className = new StringBuilder(512);
      GetClassNameW(hWnd, className, className.Capacity);
      string name = className.ToString().ToUpperInvariant();
      if (name.IndexOf("EDIT") >= 0) { found = hWnd; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  public static bool Post(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam)
  {
    return PostMessageW(hWnd, message, wParam, lParam);
  }

  /**
   * The two packed message parameters, built HERE rather than in PowerShell.
   *
   * Shifting a signed 16-bit value left by 16 is how these messages want their coordinates, and
   * PowerShell arithmetic promotes and wraps differently from C#: a negative wheel delta shifted
   * in PowerShell produced a value outside the range IntPtr accepts. Building them here means
   * there is one implementation of the packing and it is written in the language the message
   * format is defined in.
   */
  public static long PointLParam(int x, int y)
  {
    /* Cast to ushort FIRST, then widen. Writing (long)(y & 0xFFFF) looks equivalent and is not:
       the compiler warns CS0078 that the OR is applied to a sign-extended operand, and Add-Type
       in Windows PowerShell 5.1 treats warnings as errors, so a warning here is a lane that will
       not compile. Measured: this payload failed to compile with exactly that message. */
    long high = (long)(ushort)y;
    long low = (long)(ushort)x;
    return (high << 16) | low;
  }

  public static long WheelWParam(int delta)
  {
    return (long)(ushort)delta << 16;
  }

  /** Where the middle of a window client area is, in screen coordinates. */
  public static bool ClientCenterOnScreen(IntPtr hWnd, out int screenX, out int screenY)
  {
    screenX = 0;
    screenY = 0;
    RECT client;
    if (!GetClientRect(hWnd, out client)) return false;
    POINT point = new POINT();
    point.X = (client.Right - client.Left) / 2;
    point.Y = (client.Bottom - client.Top) / 2;
    if (!ClientToScreen(hWnd, ref point)) return false;
    screenX = point.X;
    screenY = point.Y;
    return true;
  }

  /**
   * Capture one window into a BMP file, and say WHICH route produced the pixels.
   *
   * PrintWindow is asked first with PW_RENDERFULLCONTENT (2), then with 0, and only then is
   * BitBlt from the window DC tried. The route is returned rather than assumed: a capture that
   * silently fell back to a screen grab of an occluded window would produce a plausible file
   * of the wrong pixels, and a measurement that cannot tell those apart is not a measurement.
   * Route 2 and 0 are PrintWindow, route 3 is BitBlt, route 0 with ok 0 is nothing.
   */
  public static int Capture(IntPtr hWnd, string path, out int width, out int height, out int route, out int printWindowError)
  {
    RECT logical; GetWindowRect(hWnd,out logical);
    IntPtr dpi=SetThreadDpiAwarenessContext(GetWindowDpiAwarenessContext(hWnd));
    try { return CaptureInContext(hWnd,path,logical.Right-logical.Left,logical.Bottom-logical.Top,out width,out height,out route,out printWindowError); }
    finally { if(dpi!=IntPtr.Zero)SetThreadDpiAwarenessContext(dpi); }
  }
  [DllImport("user32.dll")] static extern IntPtr GetWindowDpiAwarenessContext(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("gdi32.dll")] static extern int SetStretchBltMode(IntPtr dc,int mode);
  [DllImport("gdi32.dll")] static extern bool StretchBlt(IntPtr to,int x,int y,int width,int height,IntPtr from,int sx,int sy,int sourceWidth,int sourceHeight,uint operation);
  static int CaptureInContext(IntPtr hWnd, string path,int logicalWidth,int logicalHeight,out int width,out int height,out int route,out int printWindowError)
  {
    width = 0; height = 0; route = 0; printWindowError = 0;
    if (!IsWindow(hWnd)) return 0;
    RECT rect;
    if (!GetWindowRect(hWnd, out rect)) return 0;
    int w = rect.Right - rect.Left;
    int h = rect.Bottom - rect.Top;
    if (w <= 0 || h <= 0) return 0;
    IntPtr windowDc = GetWindowDC(hWnd);
    if (windowDc == IntPtr.Zero) return 0;
    IntPtr memoryDc = IntPtr.Zero;
    IntPtr bitmap = IntPtr.Zero;
    IntPtr previous = IntPtr.Zero;
    try
    {
      memoryDc = CreateCompatibleDC(windowDc);
      if (memoryDc == IntPtr.Zero) return 0;
      bitmap = CreateCompatibleBitmap(windowDc, w, h);
      if (bitmap == IntPtr.Zero) return 0;
      previous = SelectObject(memoryDc, bitmap);
      bool captured = false;
      if (PrintWindow(hWnd, memoryDc, 2)) { route = 2; captured = true; }
      else if (PrintWindow(hWnd, memoryDc, 0)) { route = 0; captured = true; }
      else if (BitBlt(memoryDc, 0, 0, w, h, windowDc, 0, 0, SRCCOPY)) { route = 3; captured = true; }
      if (!captured) { printWindowError = Marshal.GetLastWin32Error(); return 0; }
      // Preserve the agent's advertised coordinate space, even when the target is PMv2.
      if(logicalWidth>0&&logicalHeight>0&&(logicalWidth!=w||logicalHeight!=h)) {
        IntPtr scaledDc=CreateCompatibleDC(windowDc),scaledBitmap=CreateCompatibleBitmap(windowDc,logicalWidth,logicalHeight);
        if(scaledDc==IntPtr.Zero||scaledBitmap==IntPtr.Zero){if(scaledDc!=IntPtr.Zero)DeleteDC(scaledDc);if(scaledBitmap!=IntPtr.Zero)DeleteObject(scaledBitmap);return 0;}
        IntPtr scaledPrevious=SelectObject(scaledDc,scaledBitmap);SetStretchBltMode(scaledDc,4);
        bool scaled=StretchBlt(scaledDc,0,0,logicalWidth,logicalHeight,memoryDc,0,0,w,h,SRCCOPY);
        if(!scaled){SelectObject(scaledDc,scaledPrevious);DeleteObject(scaledBitmap);DeleteDC(scaledDc);return 0;}
        SelectObject(memoryDc,previous);DeleteObject(bitmap);DeleteDC(memoryDc);
        memoryDc=scaledDc;bitmap=scaledBitmap;previous=scaledPrevious;w=logicalWidth;h=logicalHeight;
      }
      SelectObject(memoryDc, previous);
      previous = IntPtr.Zero;
      byte[] bits = new byte[w * h * 4];
      BITMAPINFO info = new BITMAPINFO();
      info.bmiHeader.biSize = 40;
      info.bmiHeader.biWidth = w;
      info.bmiHeader.biHeight = -h;
      info.bmiHeader.biPlanes = 1;
      info.bmiHeader.biBitCount = 32;
      info.bmiHeader.biCompression = 0;
      info.bmiHeader.biSizeImage = (uint)(w * h * 4);
      int lines = GetDIBits(memoryDc, bitmap, 0, (uint)h, bits, ref info, 0);
      if (lines != h) { printWindowError = Marshal.GetLastWin32Error(); return 0; }
      WriteBmp(path, bits, w, h);
      width = w; height = h;
      return 1;
    }
    finally
    {
      if (previous != IntPtr.Zero && memoryDc != IntPtr.Zero) SelectObject(memoryDc, previous);
      if (bitmap != IntPtr.Zero) DeleteObject(bitmap);
      if (memoryDc != IntPtr.Zero) DeleteDC(memoryDc);
      ReleaseDC(hWnd, windowDc);
    }
  }

  static void WriteBmp(string path, byte[] bits, int width, int height)
  {
    int imageSize = width * height * 4;
    System.IO.FileStream stream = new System.IO.FileStream(path, System.IO.FileMode.Create, System.IO.FileAccess.Write);
    try
    {
      System.IO.BinaryWriter writer = new System.IO.BinaryWriter(stream);
      writer.Write((byte)0x42);
      writer.Write((byte)0x4D);
      writer.Write(14 + 40 + imageSize);
      writer.Write((short)0);
      writer.Write((short)0);
      writer.Write(54);
      writer.Write(40);
      writer.Write(width);
      writer.Write(-height);
      writer.Write((short)1);
      writer.Write((short)32);
      writer.Write(0);
      writer.Write(imageSize);
      writer.Write(0);
      writer.Write(0);
      writer.Write(0);
      writer.Write(0);
      writer.Write(bits);
      writer.Flush();
    }
    finally { stream.Close(); }
  }
}
`;
/* #nm-csharp-end agent-window */

/* ===================================================================================== *
 * the agent's line-protocol driver
 *
 * PowerShell, not pwsh: this runs under Windows PowerShell 5.1 so the dialect the payloads
 * are written in is the dialect they are compiled with. There is no backtick and no dollar-
 * brace anywhere in it, because a backtick would end the template literal it lives in.
 * ===================================================================================== */

/* #nm-agent-ps1-begin */
export const AGENT_PS1 = String.raw`param(
  [Parameter(Mandatory = $true)][string]$DesktopName,
  [Parameter(Mandatory = $true)][string]$PipeName,
  [Parameter(Mandatory = $true)][string]$ReadyFile,
  [Parameter(Mandatory = $true)][string]$LedgerPath,
  [Parameter(Mandatory = $true)][string]$CsharpDir,
  [Parameter(Mandatory = $true)][string]$Token,
  [string]$LogPath = '',
  [int]$OwnerPid = 0,
  [switch]$NoJob
)

$ErrorActionPreference = 'Stop'
$NewLine = [System.Environment]::NewLine
$Utf8 = New-Object System.Text.UTF8Encoding($false)
$script:nmStop = $false

# A trap at script scope, and an explicit log file, because the agent runs on a desktop nobody
# is looking at: an unhandled error would otherwise go to a console window that no one can see,
# and a bring-up that fails silently is a bring-up that cannot be debugged. The log is a file
# the caller named on the command line - never an environment variable, which is the channel
# measured to kill a child before its first instruction.
trap {
  Write-NmLog -Message ('unhandled: ' + [string]$_)
  exit 9
}

function Write-NmLog {
  param([string]$Message)
  if ($LogPath -eq '') { return }
  try {
    $stamp = [DateTime]::UtcNow.ToString('o')
    [System.IO.File]::AppendAllText($LogPath, ($stamp + ' ' + $Message + $NewLine), $Utf8)
  } catch { }
}

function ConvertTo-NmHandle {
  param([string]$Value)
  if ($Value -eq $null -or $Value -eq '') { return [IntPtr]::Zero }
  $text = $Value.Trim()
  if ($text.StartsWith('0x') -or $text.StartsWith('0X')) { $text = $text.Substring(2) }
  if ($text.Length -eq 0) { return [IntPtr]::Zero }
  # PowerShell does not parse a hexadecimal literal in a cast, so the conversion is explicit and
  # unsigned first: a handle with the top bit set is a legal handle and not a negative number.
  $raw = [System.Convert]::ToUInt64($text, 16)
  return [IntPtr][long]$raw
}

function Write-NmLedger {
  param([hashtable]$Entry)
  try {
    $line = ($Entry | ConvertTo-Json -Depth 6 -Compress)
    [System.IO.File]::AppendAllText($LedgerPath, $line + $NewLine, $Utf8)
  } catch { }
}

function New-NmLine {
  param([string]$Id, [bool]$Ok, [hashtable]$Fields)
  $envelope = @{ id = $Id; ok = $Ok }
  if ($Fields -ne $null) {
    foreach ($key in $Fields.Keys) { $envelope[$key] = $Fields[$key] }
  }
  return ($envelope | ConvertTo-Json -Depth 6 -Compress)
}

function New-NmError {
  param([string]$Id, [string]$Message)
  return (New-NmLine -Id $Id -Ok $false -Fields @{ error = $Message })
}

function Get-NmStartTimeIso {
  param([int]$ProcessId)
  try { return [NmProcessFacts]::StartTimeUtc($ProcessId) } catch { return '' }
}

function Get-NmHostedPids {
  $listed = @()
  if ($script:nmJob -ne [IntPtr]::Zero) {
    $errorCode = 0
    $assigned = 0
    $pids = [NmAgentJob]::MemberPids($script:nmJob, [ref]$errorCode, [ref]$assigned)
    foreach ($memberPid in $pids) {
      $listed += @{
        pid = [int]$memberPid
        start_time_utc = (Get-NmStartTimeIso -ProcessId ([int]$memberPid))
        start_time_ticks = [string][NmProcessFacts]::StartTimeTicks([int]$memberPid)
      }
    }
  }
  return $listed
}

# The processes that OWN A WINDOW ON THIS AGENT'S OWN DESKTOP and are not held by the job.
#
# This is the second half of the ownership question, and it exists because inheritance is not
# the whole story. A launch whose target hands its work to a process this agent did not create
# - a packaged application is the measured case - leaves a process ON this desktop that the
# job does not hold, so 'hosted' (job members) misses it and the teardown would report a clean
# end while something still occupies the desktop. A window is bound to its desktop, so every
# pid listed here is a process that is really on this agent's desktop; the read is by pid and
# never by name, and nothing here terminates anything.
function Get-NmUnheldWindowPids {
  $listed = @()
  $seen = @{}
  foreach ($fact in [NmAgentWindow]::TopLevelWindows()) {
    $ownerPid = [int]$fact.ProcessId
    if ($ownerPid -le 0 -or $ownerPid -eq $PID -or $seen.ContainsKey($ownerPid)) { continue }
    $seen[$ownerPid] = $true
    $membership = -1
    if ($script:nmJob -ne [IntPtr]::Zero) {
      $membershipError = 0
      $membership = [NmAgentJob]::PidMembership($script:nmJob, $ownerPid, [ref]$membershipError)
    }
    if ($membership -eq 1) { continue }
    $listed += @{
      pid = $ownerPid
      held = $false
      membership = [int]$membership
      title = [string]$fact.Title
      class_name = [string]$fact.ClassName
      start_time_utc = (Get-NmStartTimeIso -ProcessId $ownerPid)
      start_time_ticks = [string][NmProcessFacts]::StartTimeTicks($ownerPid)
    }
  }
  return $listed
}

function Invoke-NmAgentRequest {
  param([string]$Line)
  $request = $null
  try { $request = ConvertFrom-Json -InputObject $Line } catch { return (New-NmError -Id '' -Message ('the request is not JSON: ' + [string]$_.Exception.Message)) }
  $id = [string]$request.id
  $token = [string]$request.token
  if ($token -ne $Token) { return (New-NmError -Id $id -Message 'token mismatch') }
  $op = [string]$request.op

  if ($op -eq 'state') {
    return (New-NmLine -Id $id -Ok $true -Fields @{
      desktop_requested = $DesktopName
      desktop_thread = [NmAgentDesktop]::ThreadDesktopName()
      window_station = [NmAgentDesktop]::WindowStationName()
      desktop_hold = [NmAgentDesktop]::HoldName($script:nmDesktopHold)
      desktop_hold_value = ('0x' + $script:nmDesktopHold.ToInt64().ToString('x'))
      pid = $PID
      start_time_utc = (Get-NmStartTimeIso -ProcessId $PID)
      no_job = [bool]$NoJob
      job_created = $script:nmJobCreated
      job_assigned = $script:nmJobAssigned
      job_in_job = $script:nmJobInJob
      job_limit_flags = ('0x' + ([int]$script:nmJobLimit).ToString('x'))
      job_kill_on_close = (($script:nmJobLimit -band 0x2000) -ne 0)
      job_handle = ('0x' + $script:nmJob.ToInt64().ToString('x'))
      hosted = @(Get-NmHostedPids)
      # Every process on THIS desktop that owns a window and is not a job member. It is reported
      # by the state read, which the teardown asks BEFORE the exit, so a launch that the job does
      # not hold is inside the question the teardown asks rather than outside it.
      unheld_window_pids = @(Get-NmUnheldWindowPids)
      launched_this_agent = @($script:nmLaunched)
      token_match = $true
      shell = 'Windows PowerShell 5.1'
      types = @('NmAgentDesktop', 'NmAgentJob', 'NmAgentProcess', 'NmAgentWindow', 'NmProcessFacts')
    })
  }

  if ($op -eq 'enumerate') {
    $windows = @()
    foreach ($fact in [NmAgentWindow]::TopLevelWindows()) {
      $windows += @{
        handle = ('0x' + ([long]$fact.Handle).ToString('x'))
        title = [string]$fact.Title
        class_name = [string]$fact.ClassName
        pid = [int]$fact.ProcessId
        thread_id = [int]$fact.ThreadId
        rect = @{ x = [int]$fact.Left; y = [int]$fact.Top; width = [int]($fact.Right - $fact.Left); height = [int]($fact.Bottom - $fact.Top) }
        client = @{ width = [int]$fact.ClientWidth; height = [int]$fact.ClientHeight }
        visible = [bool]$fact.Visible
        minimized = [bool]$fact.Minimized
      }
    }
    return (New-NmLine -Id $id -Ok $true -Fields @{
      desktop = [NmAgentDesktop]::ThreadDesktopName()
      window_station = [NmAgentDesktop]::WindowStationName()
      window_count = $windows.Count
      windows = $windows
      foreground = ('0x' + [NmAgentWindow]::GetForegroundWindow().ToInt64().ToString('x'))
    })
  }

  if ($op -eq 'children') {
    $parent = ConvertTo-NmHandle -Value ([string]$request.handle)
    $children = @()
    foreach ($fact in [NmAgentWindow]::ChildWindows($parent)) {
      $children += @{
        handle = ('0x' + ([long]$fact.Handle).ToString('x'))
        title = [string]$fact.Title
        class_name = [string]$fact.ClassName
        pid = [int]$fact.ProcessId
        client = @{ width = [int]$fact.ClientWidth; height = [int]$fact.ClientHeight }
        visible = [bool]$fact.Visible
      }
    }
    return (New-NmLine -Id $id -Ok $true -Fields @{
      handle = [string]$request.handle
      is_window = [bool][NmAgentWindow]::IsWindow($parent)
      child_count = $children.Count
      children = $children
    })
  }

  if ($op -eq 'capture') {
    $target = ConvertTo-NmHandle -Value ([string]$request.handle)
    $outPath = [string]$request.path
    $width = 0; $height = 0; $route = 0; $printError = 0
    $ok = [NmAgentWindow]::Capture($target, $outPath, [ref]$width, [ref]$height, [ref]$route, [ref]$printError)
    if ($ok -ne 1) {
      return (New-NmLine -Id $id -Ok $false -Fields @{
        error = 'PrintWindow and BitBlt both produced nothing'
        print_window_error = [int]$printError
        is_window = [bool][NmAgentWindow]::IsWindow($target)
      })
    }
    $bytes = [System.IO.File]::ReadAllBytes($outPath)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $digest = [System.BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '').ToLowerInvariant()
    return (New-NmLine -Id $id -Ok $true -Fields @{
      handle = [string]$request.handle
      path = $outPath
      bytes = [int]$bytes.Length
      sha256 = $digest
      width = [int]$width
      height = [int]$height
      route = [int]$route
      desktop = [NmAgentDesktop]::ThreadDesktopName()
    })
  }

  if ($op -eq 'click') {
    $target = ConvertTo-NmHandle -Value ([string]$request.handle)
    $x = [int]$request.x
    $y = [int]$request.y
    $point = [NmAgentWindow]::PointLParam($x, $y)
    $moved = [NmAgentWindow]::Post($target, [NmAgentWindow]::WM_MOUSEMOVE, [IntPtr]::Zero, [IntPtr][long]$point)
    $down = [NmAgentWindow]::Post($target, [NmAgentWindow]::WM_LBUTTONDOWN, [IntPtr][long]1, [IntPtr][long]$point)
    $up = [NmAgentWindow]::Post($target, [NmAgentWindow]::WM_LBUTTONUP, [IntPtr]::Zero, [IntPtr][long]$point)
    return (New-NmLine -Id $id -Ok $true -Fields @{
      handle = [string]$request.handle
      x = $x
      y = $y
      is_window = [bool][NmAgentWindow]::IsWindow($target)
      posted = @{ moved = [bool]$moved; down = [bool]$down; up = [bool]$up }
    })
  }

  if ($op -eq 'type') {
    $target = ConvertTo-NmHandle -Value ([string]$request.handle)
    $edit = [NmAgentWindow]::FindEditChild($target)
    $landed = $target
    if ($edit -ne [IntPtr]::Zero) { $landed = $edit }
    $text = [string]$request.text
    $posted = 0
    foreach ($character in $text.ToCharArray()) {
      $code = [int][char]$character
      if ([NmAgentWindow]::Post($landed, [NmAgentWindow]::WM_CHAR, [IntPtr][long]$code, [IntPtr]::Zero)) { $posted = $posted + 1 }
    }
    return (New-NmLine -Id $id -Ok $true -Fields @{
      handle = [string]$request.handle
      target_handle = ('0x' + $landed.ToInt64().ToString('x'))
      used_edit_child = ($edit -ne [IntPtr]::Zero)
      characters = $text.Length
      posted = [int]$posted
    })
  }

  if ($op -eq 'key') {
    $target = ConvertTo-NmHandle -Value ([string]$request.handle)
    $virtualKey = [int]$request.vk
    $down = [NmAgentWindow]::Post($target, [NmAgentWindow]::WM_KEYDOWN, [IntPtr][long]$virtualKey, [IntPtr]::Zero)
    $up = [NmAgentWindow]::Post($target, [NmAgentWindow]::WM_KEYUP, [IntPtr][long]$virtualKey, [IntPtr]::Zero)
    return (New-NmLine -Id $id -Ok $true -Fields @{
      handle = [string]$request.handle
      vk = $virtualKey
      posted = @{ down = [bool]$down; up = [bool]$up }
    })
  }

  if ($op -eq 'scroll') {
    $target = ConvertTo-NmHandle -Value ([string]$request.handle)
    $delta = [int]$request.delta
    $screenX = 0
    $screenY = 0
    $centered = [NmAgentWindow]::ClientCenterOnScreen($target, [ref]$screenX, [ref]$screenY)
    $wheelParam = [NmAgentWindow]::WheelWParam($delta)
    $pointParam = [NmAgentWindow]::PointLParam($screenX, $screenY)
    $posted = [NmAgentWindow]::Post($target, [NmAgentWindow]::WM_MOUSEWHEEL, [IntPtr][long]$wheelParam, [IntPtr][long]$pointParam)
    return (New-NmLine -Id $id -Ok $true -Fields @{
      handle = [string]$request.handle
      delta = $delta
      posted = [bool]$posted
      centered = [bool]$centered
      screen = @{ x = [int]$screenX; y = [int]$screenY }
    })
  }

  if ($op -eq 'launch') {
    $commandLine = [string]$request.command_line
    $errorCode = 0
    # WHEN THIS LAUNCH BEGAN, so a pid that answered can be told from a process this launch made.
    # The boundary below is 5 seconds in FILETIME ticks (10^7 per second), which is far longer than
    # a create-and-answer round trip and far shorter than any plausible pre-existing process.
    $launchMarkTicks = [long][DateTime]::UtcNow.ToFileTimeUtc()
    $started = [NmAgentProcess]::LaunchOn($DesktopName, $commandLine, [ref]$errorCode)
    if ($started -eq 0) {
      return (New-NmLine -Id $id -Ok $false -Fields @{
        error = 'CreateProcessW refused the launch'
        last_error = [int]$errorCode
        command_line = $commandLine
        desktop = $DesktopName
      })
    }
    # THE MEMBERSHIP IS MEASURED AFTER THE LAUNCH, IN THREE STEPS, AND EACH ONE IS REPORTED.
    #
    # Inheritance is the mechanism that is supposed to make this unnecessary - a child of a job
    # member is in the job - and it is not sufficient. Measured on this station: an agent that
    # reported job_in_job: true launched notepad.exe and the child came back NOT a member,
    # while the same agent launching a plain Win32 program produced a member. A process outside
    # the job is not killed by KILL_ON_JOB_CLOSE, so the desktop it sits on outlives the agent
    # that made it, invisibly.
    #
    # So: read membership as a three-valued answer (a failed OpenProcess is NOT "not a member"),
    # cross-check it against the job's own member list, and if the child is not a member PUT IT
    # THERE and read again. 'held' is the answer after all of that; a launch that could not be
    # held says so, with the reason, and the caller reports it as unowned rather than absent.
    $startTicks = 0
    try { $startTicks = [NmProcessFacts]::StartTimeTicks([int]$started) } catch { }
    $membership = -1
    $membershipError = 0
    $memberListed = $false
    $maybe = $true
    if ($script:nmJob -ne [IntPtr]::Zero) {
      try { $membership = [NmAgentJob]::PidMembership($script:nmJob, [int]$started, [ref]$membershipError) } catch { $membership = -1 }
    } else {
      $maybe = $false
    }
    $membershipBefore = [int]$membership
    $inherited = ($membership -eq 1)
    # OURS, OR MERELY THE PID THAT ANSWERED.
    #
    # A launch that hands its work to the shell's activation host can answer with a process this
    # launch did not create - including one that was already running. Assigning THAT to the job
    # would claim, and later kill, something that was never this route's. So a process whose
    # creation time predates the launch is reported as NOT ours: it is checked by the teardown and
    # named as a survivor, but it is never adopted.
    $ours = $true
    if ($startTicks -gt 0) {
      if ([long]$startTicks -lt ([long]$launchMarkTicks - 50000000)) { $ours = $false }
    }
    $assigned = $false
    $assignError = 0
    if (-not $inherited -and $maybe -and $ours) {
      try { $assigned = [NmAgentJob]::AssignPid($script:nmJob, [int]$started, [ref]$assignError) } catch { $assigned = $false }
      if ($assigned) {
        $membershipError = 0
        try { $membership = [NmAgentJob]::PidMembership($script:nmJob, [int]$started, [ref]$membershipError) } catch { $membership = -1 }
      }
    }
    if ($maybe) {
      $listError = 0
      $assignedCount = 0
      # @(...) on purpose: PowerShell unwraps a one-element array returned from a method into a
      # scalar, and '-contains' against a scalar is a different question from '-contains' against
      # the list the kernel answered with.
      $members = @()
      try { $members = @([NmAgentJob]::MemberPids($script:nmJob, [ref]$listError, [ref]$assignedCount)) } catch { $members = @() }
      $memberListed = ($members -contains [int]$started)
    }
    $held = ($membership -eq 1)
    # A second, independent read: a process on THIS desktop that is not held. It catches a target
    # that handed its work to a process this agent never created, which no membership read of the
    # created pid can see.
    $unheld = @()
    try { $unheld = @(Get-NmUnheldWindowPids) } catch { $unheld = @() }
    $unheldPids = @($unheld | ForEach-Object { [int]$_.pid })
    # No ternary: this payload runs under Windows PowerShell 5.1, which has no '? :' operator.
    $ownership = 'unowned'
    if ($held) {
      if ($inherited) { $ownership = 'inherited' } else { $ownership = 'assigned' }
    }    $script:nmLaunched += @{ pid = [int]$started; start_time_ticks = [string]$startTicks; command_line = $commandLine; held = [bool]$held; ownership = $ownership }
    Write-NmLedger -Entry @{
      kind = 'hosted'
      at = [DateTime]::UtcNow.ToString('o')
      desktop = $DesktopName
      pid = [int]$started
      start_time_utc = (Get-NmStartTimeIso -ProcessId ([int]$started))
      # A STRING, and that is not tidiness. A FILETIME tick count is about 1.3e17 and a JSON number
      # is an IEEE double, so anything above 2^53 - every real start time - is rounded on the way
      # through and stops matching the process it describes. Measured: the whole ownership
      # measurement came back "pid reuse" for its own processes because of exactly this, and the
      # reaper then refused to terminate anything.
      start_time_ticks = [string]$startTicks
      in_job = [bool]$held
      ownership = $ownership
      agent_pid = $PID
      command_line = $commandLine
    }
    return (New-NmLine -Id $id -Ok $true -Fields @{
      pid = [int]$started
      start_time_utc = (Get-NmStartTimeIso -ProcessId ([int]$started))
      start_time_ticks = [string]$startTicks
      in_job = [bool]$held
      held = [bool]$held
      ownership = $ownership
      inherited = [bool]$inherited
      assigned_after_launch = [bool]$assigned
      assign_error = [int]$assignError
      membership_before = [int]$membershipBefore
      membership_error = [int]$membershipError
      created_by_this_launch = [bool]$ours
      started_before_this_launch = [bool](-not $ours)
      launch_mark_ticks = [string]$launchMarkTicks
      member_listed = [bool]$memberListed
      job_present = [bool]$maybe
      job_in_job = [bool]$script:nmJobInJob
      unheld_window_pids = @($unheld)
      unheld_pids = @($unheldPids)
      desktop_requested = $DesktopName
      command_line = $commandLine
    })
  }

  if ($op -eq 'job') {
    $errorCode = 0
    $assigned = 0
    $pids = @()
    if ($script:nmJob -ne [IntPtr]::Zero) { $pids = [NmAgentJob]::MemberPids($script:nmJob, [ref]$errorCode, [ref]$assigned) }
    $members = @()
    foreach ($memberPid in $pids) {
      $members += @{
        pid = [int]$memberPid
        start_time_utc = (Get-NmStartTimeIso -ProcessId ([int]$memberPid))
        start_time_ticks = [string][NmProcessFacts]::StartTimeTicks([int]$memberPid)
      }
    }
    return (New-NmLine -Id $id -Ok $true -Fields @{
      no_job = [bool]$NoJob
      job_created = $script:nmJobCreated
      job_assigned = $script:nmJobAssigned
      job_kill_on_close = (($script:nmJobLimit -band 0x2000) -ne 0)
      assigned_count = [int]$assigned
      listed_count = [int]$members.Count
      members = $members
      agent_pid = $PID
    })
  }

  if ($op -eq 'pidalive') {
    $processId = [int]$request.pid
    # The expected start time arrives as a STRING and is parsed here: as a JSON number it would have
    # been rounded past 2^53 before it ever reached this line.
    $expected = [long]0
    try { $expected = [long][string]$request.start_time_ticks } catch { $expected = [long]0 }
    $ticks = [NmProcessFacts]::StartTimeTicks($processId)
    # alive means RUNNING, not "the pid resolves": a terminated process keeps answering OpenProcess
    # for seconds, and a liveness test built on that reports a corpse as alive.
    $running = $false
    if ($ticks -gt 0) { $running = [NmProcessFacts]::Running($processId) }
    return (New-NmLine -Id $id -Ok $true -Fields @{
      pid = $processId
      alive = $running
      same_process = ($running -and ($expected -le 0 -or $ticks -eq $expected))
      start_time_utc = (Get-NmStartTimeIso -ProcessId $processId)
      start_time_ticks = [string]$ticks
      image = [NmProcessFacts]::ImagePath($processId)
    })
  }

  if ($op -eq 'close_desktop') {
    $holdValue = ('0x' + $script:nmDesktopHold.ToInt64().ToString('x'))
    $closed = [NmAgentDesktop]::Close($script:nmDesktopHold)
    $script:nmDesktopHold = [IntPtr]::Zero
    $reopenError = 0
    $reopen = [NmAgentDesktop]::OpenByName($DesktopName, [ref]$reopenError)
    $reopenName = ''
    if ($reopen -ne [IntPtr]::Zero) {
      $reopenName = [NmAgentDesktop]::HoldName($reopen)
      [void][NmAgentDesktop]::Close($reopen)
    }
    # The agent does NOT stop here. Closing a desktop handle and ending the agent are two different
    # acts and the caller has to be able to measure the first without the second: a version of this
    # that also stopped the agent closed the job handle on the way out, and the processes died of
    # THAT rather than of the CloseDesktop the measurement was trying to isolate.
    return (New-NmLine -Id $id -Ok $true -Fields @{
      closed = [bool]$closed
      hold_before = $holdValue
      reopen_handle = ('0x' + $reopen.ToInt64().ToString('x'))
      reopen_error = [int]$reopenError
      reopen_name = $reopenName
      agent_still_running = $true
      desktop_thread_still = [NmAgentDesktop]::ThreadDesktopName()
    })
  }

  if ($op -eq 'exit') {
    Write-NmLedger -Entry @{
      kind = 'exit'
      at = [DateTime]::UtcNow.ToString('o')
      desktop = $DesktopName
      agent_pid = $PID
      reason = 'requested'
    }
    $script:nmStop = $true
    return (New-NmLine -Id $id -Ok $true -Fields @{ exiting = $true; desktop = $DesktopName; agent_pid = $PID })
  }

  return (New-NmError -Id $id -Message ('unsupported op: ' + $op))
}

# ---------------------------------------------------------------------------- bring-up ---

$script:nmJob = [IntPtr]::Zero
$script:nmJobCreated = $false
$script:nmJobAssigned = $false
$script:nmJobInJob = $false
$script:nmJobLimit = 0
$script:nmLaunched = @()

$types = @('NmAgentDesktop', 'NmAgentJob', 'NmAgentProcess', 'NmAgentWindow', 'NmProcessFacts')
foreach ($typeName in $types) {
  $sourcePath = [System.IO.Path]::Combine($CsharpDir, $typeName + '.cs')
  $source = [System.IO.File]::ReadAllText($sourcePath, [System.Text.Encoding]::UTF8)
  if (-not ($typeName -as [type])) {
    try {
      Add-Type -TypeDefinition $source -ErrorAction Stop
    } catch {
      $message = ($typeName + ' did not compile under Windows PowerShell 5.1: ' + [string]$_.Exception.Message)
      $failure = @{ ok = $false; event = 'bringup_failed'; stage = 'compile'; type = $typeName; error = $message; pid = $PID } | ConvertTo-Json -Depth 6 -Compress
      [System.IO.File]::WriteAllText($ReadyFile, $failure, $Utf8)
      exit 1
    }
  }
}

if ($OwnerPid -gt 0) { [NmProcessFacts]::WatchOwner($OwnerPid) }
$desktopError = 0
$script:nmDesktopHold = [NmAgentDesktop]::OpenByName($DesktopName, [ref]$desktopError)
$threadDesktop = [NmAgentDesktop]::ThreadDesktopName()
if ($script:nmDesktopHold -eq [IntPtr]::Zero) {
  $failure = @{ ok = $false; event = 'bringup_failed'; stage = 'open_desktop'; desktop = $DesktopName; desktop_error = [int]$desktopError; thread_desktop = $threadDesktop; pid = $PID } | ConvertTo-Json -Depth 6 -Compress
  [System.IO.File]::WriteAllText($ReadyFile, $failure, $Utf8)
  exit 1
}

$jobError = 0
if (-not $NoJob) {
  $script:nmJob = [NmAgentJob]::CreateKillOnClose([ref]$jobError)
  if ($script:nmJob -ne [IntPtr]::Zero) {
    $script:nmJobCreated = $true
    $script:nmJobAssigned = [NmAgentJob]::AssignSelf($script:nmJob, [ref]$jobError)
    $script:nmJobInJob = [NmAgentJob]::SelfInJob($script:nmJob)
    $limitError = 0
    $script:nmJobLimit = [NmAgentJob]::LimitFlags($script:nmJob, [ref]$limitError)
  }
}

# 254 is PIPE_UNLIMITED_INSTANCES minus one, and the number is not free: NamedPipeServerStream
# refuses 255 outright ("maxNumberOfServerInstances must be between 1 and 254"), which the agent
# reported from the hidden desktop through its own log file rather than dying silently.
function New-NmPipe {
  return (New-Object System.IO.Pipes.NamedPipeServerStream($PipeName, [System.IO.Pipes.PipeDirection]::InOut, 254, [System.IO.Pipes.PipeTransmissionMode]::Byte, [System.IO.Pipes.PipeOptions]::None, 1048576, 1048576))
}

$script:nmAcceptFailures = 0
$pipe = New-NmPipe

$ready = @{
  ok = $true
  event = 'ready'
  agent = 'newmark-computeruse-hidden-agent'
  protocol = 1
  token = $Token
  pid = $PID
  start_time_utc = (Get-NmStartTimeIso -ProcessId $PID)
  pipe = $PipeName
  desktop_requested = $DesktopName
  desktop_thread = $threadDesktop
  window_station = [NmAgentDesktop]::WindowStationName()
  desktop_hold = [NmAgentDesktop]::HoldName($script:nmDesktopHold)
  desktop_hold_value = ('0x' + $script:nmDesktopHold.ToInt64().ToString('x'))
  desktop_open_error = [int]$desktopError
  no_job = [bool]$NoJob
  job_created = $script:nmJobCreated
  job_assigned = $script:nmJobAssigned
  job_in_job = $script:nmJobInJob
  job_limit_flags = ('0x' + ([int]$script:nmJobLimit).ToString('x'))
  job_kill_on_close = (($script:nmJobLimit -band 0x2000) -ne 0)
  job_handle = ('0x' + $script:nmJob.ToInt64().ToString('x'))
  job_error = [int]$jobError
  shell = 'Windows PowerShell 5.1'
  types = $types
  csharp_dir = $CsharpDir
}
[System.IO.File]::WriteAllText($ReadyFile, ($ready | ConvertTo-Json -Depth 6 -Compress), $Utf8)

Write-NmLedger -Entry @{
  kind = 'agent_start'
  at = [DateTime]::UtcNow.ToString('o')
  desktop = $DesktopName
  agent_pid = $PID
  start_time_utc = (Get-NmStartTimeIso -ProcessId $PID)
  job_created = $script:nmJobCreated
  job_assigned = $script:nmJobAssigned
  no_job = [bool]$NoJob
  token = $Token
}

while (-not $script:nmStop) {
  # Accept, serve, disconnect, accept again - for the whole life of the agent, from any number of
  # callers. A resident agent that stops being resident after one client is not an agent.
  $connected = $false
  try {
    $pipe.WaitForConnection()
    $connected = $true
  } catch {
    # An abrupt client disconnect can leave the pipe INSTANCE broken rather than merely idle, and
    # the first version of this loop treated that as the end of the agent: it broke out, the script
    # ended, the job handle closed and the whole tree went with it. The instance is therefore
    # rebuilt instead, and only a bounded run of consecutive rebuild failures is fatal.
    Write-NmLog -Message ('wait_for_connection failed: ' + [string]$_.Exception.Message)
    $script:nmAcceptFailures = $script:nmAcceptFailures + 1
    if ($script:nmAcceptFailures -gt 20) { Write-NmLog -Message 'giving up after 20 consecutive accept failures'; break }
    try { $pipe.Dispose() } catch { }
    try { $pipe = New-NmPipe } catch { Write-NmLog -Message ('rebuilding the pipe failed: ' + [string]$_.Exception.Message); break }
    continue
  }
  $script:nmAcceptFailures = 0
  if (-not $connected) { break }
  $reader = New-Object System.IO.StreamReader($pipe, (New-Object System.Text.UTF8Encoding($false)), $false, 4096, $true)
  $writer = New-Object System.IO.StreamWriter($pipe, (New-Object System.Text.UTF8Encoding($false)), 4096, $true)
  $writer.AutoFlush = $true
  while (-not $script:nmStop) {
    $line = $null
    try { $line = $reader.ReadLine() } catch { break }
    if ($line -eq $null) { break }
    if ($line.Trim().Length -eq 0) { continue }
    $response = Invoke-NmAgentRequest -Line $line
    try { $writer.WriteLine($response) } catch { break }
  }
  try { $writer.Flush() } catch { }
  if ($script:nmStop) {
    # The answer to the exit request has been written and flushed, but this process is about to
    # close the job handle - which terminates the agent itself along with every member. Without this
    # pause the pipe is torn down under the caller, who sees "read EPIPE" instead of the answer that
    # was actually sent. Measured: the first version lost the exit receipt exactly that way.
    Start-Sleep -Milliseconds 400
  }
  try { $pipe.Disconnect() } catch { }
}

Write-NmLedger -Entry @{
  kind = 'agent_stop'
  at = [DateTime]::UtcNow.ToString('o')
  desktop = $DesktopName
  agent_pid = $PID
  reason = 'loop_finished'
  job_created = $script:nmJobCreated
}

# The job handle is NOT released here, and that is deliberate.
#
# It used to be, with a comment about closing the handle being what terminates the members - and
# that is true, but doing it HERE meant the agent killed ITSELF while the caller was still reading the
# answer to the exit request. Measured: every exit came back as "read EPIPE" instead of the receipt
# that had actually been sent, and a caller had no way to tell a clean shutdown from a crash. Nothing
# is lost by removing it: this process is about to terminate, the kernel closes every handle it holds
# as it does so, and KILL_ON_JOB_CLOSE fires on the last handle closing however that happens. The
# members still die with the agent; the caller now finds out first.
exit 0
`;
/* #nm-agent-ps1-end */

export const CSHARP_PAYLOADS = Object.freeze({
  NmHiddenMaker: MAKER_CSHARP,
  NmHiddenLauncher: LAUNCHER_CSHARP,
  NmProcessFacts: PROCESS_FACTS_CSHARP,
  NmAgentDesktop: AGENT_DESKTOP_CSHARP,
  NmAgentJob: AGENT_JOB_CSHARP,
  NmAgentProcess: AGENT_PROCESS_CSHARP,
  NmAgentWindow: AGENT_WINDOW_CSHARP,
});

/**
 * The launcher driver: create the desktop, start the agent on it, hand the hold over, close.
 *
 * The handover is the one timing question in this design and it is answered with a file rather
 * than a sleep. The agent opens its own handle to the desktop and writes the ready file; the
 * launcher polls for that file and only then closes ITS handle and exits. Closing first would
 * destroy the desktop before the agent had a handle of its own, which is precisely the
 * measured behaviour of a desktop whose last handle closed.
 */
/* #nm-launcher-ps1-begin */
export const DESKTOP_LAUNCHER_PS1 = String.raw`param(
  [Parameter(Mandatory = $true)][string]$DesktopName,
  [Parameter(Mandatory = $true)][string]$AgentCommandLineB64,
  [Parameter(Mandatory = $true)][string]$ReadyFile,
  [Parameter(Mandatory = $true)][string]$CsharpDir,
  [int]$ReadyWaitMs = 60000,
  [switch]$ReuseExisting
)

$ErrorActionPreference = 'Stop'
# The agent command line arrives base64 encoded, and that is not obfuscation. powershell.exe
# parses the arguments of a -File call itself, and it does NOT use the C runtime rule the
# quoting was written for: a quoted argument whose CONTENT contains quotes is split, so
# -DesktopName from inside the agent command line was bound again at the outer level and the
# launcher refused with "the parameter DesktopName is specified more than once". Base64 has no
# quotes and no spaces, so there is nothing left for either parser to disagree about.
$AgentCommandLine = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($AgentCommandLineB64))
$report = @{}
$report.desktop = $DesktopName
$report.created = $false
$report.existed_before = $false
$report.agent_pid = 0

$makerPath = [System.IO.Path]::Combine($CsharpDir, 'NmHiddenMaker.cs')
$launcherPath = [System.IO.Path]::Combine($CsharpDir, 'NmHiddenLauncher.cs')
# Two Add-Type calls, two assemblies, two types. The maker never declares CreateProcessW and
# the launcher never declares CreateDesktopW: a previous phase measured that compiling them
# into one type gives a child that dies before its first instruction.
Add-Type -TypeDefinition ([System.IO.File]::ReadAllText($makerPath, [System.Text.Encoding]::UTF8)) -ErrorAction Stop
Add-Type -TypeDefinition ([System.IO.File]::ReadAllText($launcherPath, [System.Text.Encoding]::UTF8)) -ErrorAction Stop

$errorCode = 0
$desktop = [IntPtr]::Zero
$probe = [NmHiddenMaker]::OpenByName($DesktopName, [ref]$errorCode)
$report.existed_before = ($probe -ne [IntPtr]::Zero)
if ($report.existed_before) {
  [void][NmHiddenMaker]::CloseDesktop($probe)
  if (-not $ReuseExisting) {
    $report.ok = $false
    $report.error = 'a desktop with this name already exists; refusing to adopt it'
    $report | ConvertTo-Json -Depth 6 -Compress
    exit 0
  }
  # Adopting an existing desktop. This path exists for one reason: the interactive desktop is
  # already there and cannot be created, so the ONLY way to run the identical agent against the
  # identical application on the interactive desktop is to start it onto a desktop somebody else
  # owns. There is no handle to hold and none to close - the desktop outlives this process, which
  # is exactly what the control needs and exactly what the hidden case must not do.
  $report.adopted = $true
} else {
  $desktop = [NmHiddenMaker]::CreateByName($DesktopName, [ref]$errorCode)
  if ($desktop -eq [IntPtr]::Zero) {
    $report.ok = $false
    $report.create_error = [int]$errorCode
    $report.error = 'CreateDesktopW returned a null handle'
    $report | ConvertTo-Json -Depth 6 -Compress
    exit 0
  }
  $report.created = $true
  $report.create_error = [int]$errorCode
  $report.desktop_kernel_name = [NmHiddenMaker]::KernelName($desktop)
}
$report.launcher_thread_desktop = [NmHiddenMaker]::DesktopName()
$report.window_station = [NmHiddenMaker]::WindowStationName()

$launchError = 0
$agentPid = [NmHiddenLauncher]::Launch($DesktopName, $AgentCommandLine, [ref]$launchError)
$report.launch_error = [int]$launchError
$report.agent_pid = [int]$agentPid
if ($agentPid -eq 0) {
  [void][NmHiddenMaker]::CloseDesktop($desktop)
  $report.ok = $false
  $report.error = 'CreateProcessW returned pid 0'
  $report | ConvertTo-Json -Depth 6 -Compress
  exit 0
}

# Wait for the agent to publish that it holds its own handle to this desktop, then let go.
$waited = 0
$readyText = ''
while ($waited -lt $ReadyWaitMs) {
  if ([System.IO.File]::Exists($ReadyFile)) {
    try { $readyText = [System.IO.File]::ReadAllText($ReadyFile, [System.Text.Encoding]::UTF8) } catch { $readyText = '' }
    if ($readyText.Length -gt 0) { break }
  }
  Start-Sleep -Milliseconds 100
  $waited = $waited + 100
}
$report.ready_waited_ms = $waited
$report.ready_text = $readyText
$report.handover = ($readyText.Length -gt 0)

# This is the handover. Closing the launcher's handle is what makes the agent's own handle the
# one that decides the desktop's lifetime - and it happens ONLY when this process created the
# desktop. An adopted desktop is someone else's and is left strictly alone.
if ($report.created) {
  $report.closed_launcher_handle = [NmHiddenMaker]::CloseDesktop($desktop)
} else {
  $report.closed_launcher_handle = $false
  $report.close_skipped = 'the desktop was adopted, not created'
}
$report.ok = $true
$report | ConvertTo-Json -Depth 6 -Compress
exit 0
`;
/* #nm-launcher-ps1-end */

/**
 * The desktop keeper: hold a desktop open, and nothing else.
 *
 * It exists so that "the job killed the processes" and "the desktop died and took everything
 * with it" can be told apart. With a keeper holding the desktop, killing the agent does NOT
 * destroy the desktop, so what dies afterwards died because of the job handle and for no other
 * reason. It reads its standard input until end of stream: closing the stream is the release,
 * and it is the caller that decides when.
 */
/* #nm-keeper-ps1-begin */
export const DESKTOP_KEEPER_PS1 = String.raw`param(
  [Parameter(Mandatory = $true)][string]$DesktopName,
  [Parameter(Mandatory = $true)][string]$ReadyFile,
  [Parameter(Mandatory = $true)][string]$CsharpDir
)

$ErrorActionPreference = 'Stop'
$Utf8 = New-Object System.Text.UTF8Encoding($false)
$makerPath = [System.IO.Path]::Combine($CsharpDir, 'NmHiddenMaker.cs')
Add-Type -TypeDefinition ([System.IO.File]::ReadAllText($makerPath, [System.Text.Encoding]::UTF8)) -ErrorAction Stop

$errorCode = 0
$hold = [NmHiddenMaker]::OpenByName($DesktopName, [ref]$errorCode)
$report = @{
  ok = ($hold -ne [IntPtr]::Zero)
  event = 'keeper_ready'
  desktop = $DesktopName
  pid = $PID
  open_error = [int]$errorCode
  hold_value = ('0x' + $hold.ToInt64().ToString('x'))
}
[System.IO.File]::WriteAllText($ReadyFile, ($report | ConvertTo-Json -Depth 6 -Compress), $Utf8)
if ($hold -eq [IntPtr]::Zero) { exit 1 }

# Hold until standard input ends. Nothing else: no window, no message loop, no process.
while ($true) {
  $line = [System.Console]::In.ReadLine()
  if ($line -eq $null) { break }
}
[void][NmHiddenMaker]::CloseDesktop($hold)
exit 0
`;
/* #nm-keeper-ps1-end */

/* ===================================================================================== *
 * the Node side
 * ===================================================================================== */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Write the payloads to disk once and answer with the directory.
 *
 * Configuration travels as PATHS on a command line rather than through the environment: the
 * measured failure this module is built around is a child that dies before its first
 * instruction when its configuration arrives as an environment variable, and a 44 KB C# block
 * cannot travel as a command-line argument under CreateProcess's 32 KB limit anyway.
 */
export function writeAgentPayloads(directory) {
  const target = directory || path.join(runtimeRoot(), 'payload');
  fs.mkdirSync(target, { recursive: true });
  const files = {};
  for (const [name, source] of Object.entries(CSHARP_PAYLOADS)) {
    const file = path.join(target, `${name}.cs`);
    const encoded = Buffer.from(source, 'utf8');
    let existing = null;
    try { existing = fs.readFileSync(file); } catch { existing = null; }
    if (!existing || !existing.equals(encoded)) fs.writeFileSync(file, encoded);
    files[name] = file;
  }
  const agentScript = path.join(target, 'agent.ps1');
  const launcherScript = path.join(target, 'launch-desktop.ps1');
  const keeperScript = path.join(target, 'keep-desktop.ps1');
  const scripts = [
    [agentScript, AGENT_PS1],
    [launcherScript, DESKTOP_LAUNCHER_PS1],
    [keeperScript, DESKTOP_KEEPER_PS1],
  ];
  for (const [file, source] of scripts) {
    const encoded = Buffer.from(source.replace(/\r?\n/g, '\r\n'), 'utf8');
    let existing = null;
    try { existing = fs.readFileSync(file); } catch { existing = null; }
    if (!existing || !existing.equals(encoded)) fs.writeFileSync(file, encoded);
  }
  return { directory: target, files, agentScript, launcherScript, keeperScript };
}

/** Quote one argument for a CreateProcessW command line. */
export function quoteArgument(value) {
  const text = String(value === null || value === undefined ? '' : value);
  if (text.length > 0 && !/[\s"]/.test(text)) return text;
  let out = '"';
  let backslashes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const character = text[i];
    if (character === '\\') { backslashes += 1; out += character; continue; }
    if (character === '"') { out += '\\'.repeat(backslashes + 1) + '"'; backslashes = 0; continue; }
    backslashes = 0;
    out += character;
  }
  out += '\\'.repeat(backslashes) + '"';
  return out;
}

/** Run one pwsh program that prints a single JSON line marked with a prefix, and parse it. */
function markedJson(output, marker) {
  const lines = String(output === null || output === undefined ? '' : output).split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    const at = line.indexOf(marker);
    if (at < 0) continue;
    const text = line.slice(at + marker.length).trim();
    if (!text.startsWith('{')) continue;
    try { return { ok: true, value: JSON.parse(text) }; } catch (error) { return { ok: false, reason: String(error && error.message) }; }
  }
  return { ok: false, reason: `no ${marker} line in the output` };
}

/** A small in-process pwsh program runner, for the harness side of the measurements. */
export function runPowerShell(script, options = {}) {
  const executable = options.executable || windowsPowerShellPath();
  const timeoutMs = options.timeoutMs || 120000;
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script];
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* ignore */ }
      resolve({ ok: false, output: out, stderr: err, error: `timed out after ${timeoutMs} ms`, pid: child.pid });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { out += String(chunk); });
    child.stderr.on('data', (chunk) => { err += String(chunk); });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, output: out, stderr: err, error: error && error.message, pid: child.pid });
    });
    child.once('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, code, output: out, stderr: err, error: code === 0 ? null : `exit ${code}`, pid: child.pid });
    });
  });
}

/**
 * A script that compiles one C# payload and answers with a marked JSON line.
 *
 * The payload is handed over base64 on the pipe rather than as a `-Command` argument, because
 * the helper this component already ships grew to within a few hundred bytes of the 32 KB
 * command-line limit once before and the fix recorded in `lib/win32.js` was to stop putting C#
 * on the command line. The same rule is applied here rather than rediscovered.
 */
function factsScript(prelude) {
  const encoded = Buffer.from(PROCESS_FACTS_CSHARP, 'utf8').toString('base64');
  return [
    '$ErrorActionPreference = "Stop"',
    '$Utf8 = New-Object System.Text.UTF8Encoding($false)',
    "$source = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String(@'",
    encoded,
    "'@))",
    'if (-not ("NmProcessFacts" -as [type])) { Add-Type -TypeDefinition $source -ErrorAction Stop }',
    ...prelude,
  ].join('\n');
}

/**
 * Read the ledger, and answer with the entries that are still worth acting on.
 *
 * A malformed line is reported and skipped rather than thrown: a ledger that cannot be parsed
 * must not stop an agent from starting, and a reaper that dies on one bad line is a reaper that
 * never runs again.
 */
export function readLedger(file) {
  const target = file || ledgerPath();
  let text = '';
  try { text = fs.readFileSync(target, 'utf8'); } catch { return { file: target, exists: false, entries: [], malformed: 0 }; }
  const entries = [];
  let malformed = 0;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') entries.push(parsed);
      else malformed += 1;
    } catch { malformed += 1; }
  }
  return { file: target, exists: true, entries, malformed };
}

/**
 * Reap what a job handle could not survive.
 *
 * Every recorded hosted pid is checked against the START TIME that was recorded with it, and
 * only a process that is still the same process is terminated. A pid that has been reused by
 * something else answers `reused` and is left strictly alone - which is the whole reason the
 * ledger stores a start time instead of a pid.
 */
export async function reapLedger(options = {}) {
  const ledger = readLedger(options.file);
  const hosted = new Map();
  for (const entry of ledger.entries) {
    if (!entry || entry.kind !== 'hosted') continue;
    const pid = Number(entry.pid);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    hosted.set(pid, {
      pid,
      desktop: String(entry.desktop === null || entry.desktop === undefined ? '' : entry.desktop),
      /*
       * A STRING, and this is the whole point of the ledger.
       *
       * A FILETIME tick count is about 1.3e17. A JSON number is an IEEE double, exact only to 2^53,
       * so a start time that arrives through JSON.parse as a NUMBER comes back rounded - and a
       * rounded start time matches nothing, so the reaper reports every one of its OWN processes as
       * "pid reused" and terminates none of them. Measured: that is exactly what happened, and the
       * programs survived the reap because of it. An entry written before this fix holds a number;
       * it is coerced to a string here so an old ledger reads as unmatchable rather than as a wrong
       * match.
       */
      startTimeTicks: String(entry.start_time_ticks === null || entry.start_time_ticks === undefined ? '' : entry.start_time_ticks),
      startTimeUtc: String(entry.start_time_utc === null || entry.start_time_utc === undefined ? '' : entry.start_time_utc),
      commandLine: String(entry.command_line === null || entry.command_line === undefined ? '' : entry.command_line),
    });
  }
  const candidates = [...hosted.values()];
  if (candidates.length === 0) return { file: ledger.file, malformed: ledger.malformed, candidates: 0, terminated: [], already_gone: [], reused: [], failed: [] };
  const prelude = [
    '$results = New-Object System.Collections.ArrayList',
    `$candidates = ConvertFrom-Json -InputObject ([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String("${Buffer.from(JSON.stringify(candidates), 'utf8').toString('base64')}")))`,
    'foreach ($candidate in $candidates) {',
    '  $errorCode = 0',
    '  $outcome = [NmProcessFacts]::TerminateIfStartTime([int]$candidate.pid, [long]$candidate.startTimeTicks, [ref]$errorCode)',
    '  [void]$results.Add(@{ pid = [int]$candidate.pid; start_time_utc = [string]$candidate.startTimeUtc; outcome = [int]$outcome; last_error = [int]$errorCode })',
    '}',
    '$payload = @{ results = @($results) } | ConvertTo-Json -Depth 6 -Compress',
    'Write-Output ("NMREAP " + $payload)',
  ];
  if (options.dryRun) {
    prelude.splice(prelude.length - 6, 0, '');
  }
  const raw = await runPowerShell(factsScript(prelude), { timeoutMs: options.timeoutMs || 60000 });
  const parsed = markedJson(raw.output, 'NMREAP ');
  if (!parsed.ok) return { file: ledger.file, malformed: ledger.malformed, candidates: candidates.length, error: raw.error || parsed.reason, stderr: raw.stderr.slice(-2000) };
  const results = Array.isArray(parsed.value.results) ? parsed.value.results : (parsed.value.results ? [parsed.value.results] : []);
  const buckets = { terminated: [], already_gone: [], reused: [], failed: [] };
  for (const item of results) {
    const record = { pid: Number(item.pid), start_time_utc: item.start_time_utc, last_error: Number(item.last_error) };
    const outcome = Number(item.outcome);
    if (outcome === 1) buckets.terminated.push(record);
    else if (outcome === 0) buckets.already_gone.push(record);
    else if (outcome === -1) buckets.reused.push(record);
    else buckets.failed.push(record);
  }
  return { file: ledger.file, malformed: ledger.malformed, candidates: candidates.length, ...buckets };
}

/* ------------------------------------------------------------------ the endpoint --- */

/**
 * One line-protocol request over one connection.
 *
 * A connection per request, deliberately. The agent serves one client at a time in a loop, so
 * the transport stays a plain line protocol that ANY process can speak - which is what lets
 * the lane be a second endpoint to the same agent rather than a second implementation of it.
 * A held-open connection would make the agent a private channel of this module and the lane
 * relay below impossible.
 */
export function hiddenAgentRequest(pipeName, request, options = {}) {
  const timeoutMs = options.timeoutMs || 60000;
  const line = `${JSON.stringify(request)}\n`;
  return new Promise((resolve) => {
    let settled = false;
    let buffer = '';
    const socket = net.connect(`\\\\.\\pipe\\${pipeName}`);
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.destroy(); } catch { /* ignore */ }
      resolve(value);
    };
    const timer = setTimeout(() => finish({ ok: false, error: `the hidden agent did not answer within ${timeoutMs} ms` }), timeoutMs);
    socket.on('connect', () => { socket.write(line, 'utf8'); });
    socket.on('data', (chunk) => {
      buffer += String(chunk);
      const at = buffer.indexOf('\n');
      if (at < 0) return;
      const text = buffer.slice(0, at).trim();
      if (!text) return;
      try { finish({ ok: true, value: JSON.parse(text) }); } catch (error) { finish({ ok: false, error: `the agent answer is not JSON: ${String(error && error.message)}`, raw: text.slice(0, 400) }); }
    });
    socket.on('error', (error) => finish({ ok: false, error: String(error && error.message) }));
    socket.on('close', () => finish({ ok: false, error: 'the agent closed the connection without answering' }));
  });
}

/** The agent as a caller uses it: a state read, then requests by name. */
export class HiddenAgentEndpoint {
  constructor(details) {
    Object.assign(this, details);
  }

  get pipeName() { return this.details.pipe; }

  request(op, fields = {}, options = {}) {
    const id = randomUUID();
    return hiddenAgentRequest(this.pipe, { token: this.token, id, op, ...fields }, options).then((answer) => {
      if (!answer.ok) return { ok: false, id, op, error: answer.error, raw: answer.raw };
      const value = answer.value || {};
      if (value.ok !== true) return { ok: false, id, op, error: value.error || 'the agent refused the request', value };
      return { ok: true, id, op, value };
    });
  }

  enumerate(options) { return this.request('enumerate', {}, options); }
  state(options) { return this.request('state', {}, options); }
  children(handle, options) { return this.request('children', { handle }, options); }
  capture(handle, file, options) { return this.request('capture', { handle, path: file }, options); }
  click(handle, x, y, options) { return this.request('click', { handle, x, y }, options); }
  type(handle, text, options) { return this.request('type', { handle, text }, options); }
  key(handle, vk, options) { return this.request('key', { handle, vk }, options); }
  scroll(handle, delta, options) { return this.request('scroll', { handle, delta }, options); }
  launch(commandLine, options) { return this.request('launch', { command_line: commandLine }, options); }
  job(options) { return this.request('job', {}, options); }
  pidAlive(pid, startTimeTicks, options) { return this.request('pidalive', { pid, start_time_ticks: String(startTimeTicks === null || startTimeTicks === undefined ? '' : startTimeTicks) }, options); }
  closeDesktop(options) { return this.request('close_desktop', {}, options); }
  exit(options) { return this.request('exit', {}, options); }
}

/* --------------------------------------------------------------- starting it up --- */

/**
 * Create a desktop, start the agent on it, and answer with an endpoint.
 *
 * The order is the measured one and it is not negotiable: create the desktop and HOLD it,
 * start the agent onto it by `lpDesktop`, let the agent open its own handle, and only then
 * drop the creator's handle. The launcher driver does the waiting; this function only pays for
 * it.
 */
export async function startHiddenDesktopAgent(options = {}) {
  const desktopName = options.desktopName || `NmCuAgent${String(process.pid).slice(-6)}${Math.floor(Math.random() * 1000)}`;
  const token = options.token || randomUUID().replace(/-/g, '');
  const payloads = writeAgentPayloads(options.payloadDirectory);
  const scratch = options.scratchDirectory || path.join(os.tmpdir(), 'nm-cu-agent', token);
  fs.mkdirSync(scratch, { recursive: true });
  const readyFile = path.join(scratch, 'agent-ready.json');
  const launchReportFile = path.join(scratch, 'launch-report.json');
  const agentLog = path.join(scratch, 'agent.out.txt');
  const pipeName = `nm-cu-agent-${token}`;
  const ledger = options.ledgerFile || ledgerPath();
  fs.mkdirSync(path.dirname(ledger), { recursive: true });
  try { fs.rmSync(readyFile, { force: true }); } catch { /* ignore */ }

  const agentArguments = [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', quoteArgument(payloads.agentScript),
    '-DesktopName', quoteArgument(desktopName),
    '-PipeName', quoteArgument(pipeName),
    '-ReadyFile', quoteArgument(readyFile),
    '-LedgerPath', quoteArgument(ledger),
    '-CsharpDir', quoteArgument(payloads.directory),
    '-Token', quoteArgument(token),
    '-LogPath', quoteArgument(agentLog),
    '-OwnerPid', String(process.pid),
  ];
  if (options.noJob) agentArguments.push('-NoJob');
  // The agent names its own log file and writes to it with the file API. It is NOT a shell
  // redirect: CreateProcessW starts powershell.exe directly, no shell parses that command line,
  // and a redirect token would arrive as a literal argument. Configuration still travels as
  // PATHS on the command line, which is the channel that was measured to work - never as an
  // environment variable, which is the channel that was measured to kill a child before its
  // first instruction.
  const agentCommandLine = `${quoteArgument(windowsPowerShellPath())} ${agentArguments.join(' ')}`;

  // RAW values, quoted exactly once where the command line is assembled. Quoting here and
  // again at the call site put literal quote characters inside the -File argument, and
  // powershell.exe answered "the file does not have a .ps1 extension" - a one-line bug that
  // costs a five-minute launch timeout to see, which is why the quoting happens in one place.
  const launcherArguments = [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', payloads.launcherScript,
    '-DesktopName', desktopName,
    '-AgentCommandLineB64', Buffer.from(agentCommandLine, 'utf8').toString('base64'),
    '-ReadyFile', readyFile,
    '-CsharpDir', payloads.directory,
    '-ReadyWaitMs', String(options.readyWaitMs || 60000),
  ];
  if (options.reuseExisting) launcherArguments.push('-ReuseExisting');

  const launched = await runPowerShell(
    `& ${quoteArgument(windowsPowerShellPath())} ${launcherArguments.map(quoteArgument).join(' ')}`,
    { timeoutMs: options.launchTimeoutMs || 120000 },
  );
  const report = markedJson(launched.output, '');
  let launchReport = null;
  try { launchReport = JSON.parse(String(launched.output).trim().split(/\r?\n/).filter(Boolean).pop() || 'null'); } catch { launchReport = null; }
  fs.writeFileSync(launchReportFile, String(launched.output || ''), 'utf8');

  const endpoint = new HiddenAgentEndpoint({
    desktopName,
    token,
    pipe: pipeName,
    readyFile,
    scratch,
    ledger,
    payloads,
    agentCommandLine,
    launchReportFile,
    agentLog,
    launcher: { report: launchReport, exit: launched.code, error: launched.error, stderr: String(launched.stderr || '').slice(-4000), stdout: String(launched.output || '').slice(-4000) },
    launcherPid: launched.pid,
    _raw: launched,
  });
  if (report.ok === false && !report.value) { /* keep going: the ready file still decides */ }

  // The ready file is written by the agent AFTER it holds its own desktop handle, so its
  // presence is the evidence that the handover happened and not merely that something started.
  const deadline = Date.now() + (options.readyWaitMs || 60000);
  let ready = null;
  while (Date.now() < deadline) {
    try {
      const text = fs.readFileSync(readyFile, 'utf8');
      if (text && text.trim()) { ready = JSON.parse(text); break; }
    } catch { /* not there yet */ }
    await sleep(100);
  }
  endpoint.ready = ready;
  if (!ready || ready.ok !== true) {
    endpoint.startError = ready
      ? `the agent refused to come up: ${JSON.stringify(ready)}`
      : `the agent wrote no ready file within ${options.readyWaitMs || 60000} ms (launcher said: ${JSON.stringify(launchReport)})`;
  }
  return endpoint;
}

/**
 * Hold a desktop open from a process that is not the agent, so the two deaths can be told
 * apart. Closing the returned handle's standard input releases the hold.
 */
export async function startDesktopKeeper(desktopName, options = {}) {
  const payloads = writeAgentPayloads(options.payloadDirectory);
  const scratch = options.scratchDirectory || path.join(os.tmpdir(), 'nm-cu-agent', `keeper-${process.pid}-${Date.now()}`);
  fs.mkdirSync(scratch, { recursive: true });
  const readyFile = path.join(scratch, 'keeper-ready.json');
  try { fs.rmSync(readyFile, { force: true }); } catch { /* ignore */ }
  const child = spawn(
    windowsPowerShellPath(),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', payloads.keeperScript,
      '-DesktopName', desktopName, '-ReadyFile', readyFile, '-CsharpDir', payloads.directory],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const deadline = Date.now() + 30000;
  let ready = null;
  while (Date.now() < deadline) {
    try {
      const text = fs.readFileSync(readyFile, 'utf8');
      if (text && text.trim()) { ready = JSON.parse(text); break; }
    } catch { /* not there yet */ }
    await sleep(100);
  }
  return {
    pid: child.pid,
    readyFile,
    ready,
    ok: Boolean(ready && ready.ok === true),
    release() {
      try { child.stdin.end(); } catch { /* ignore */ }
      return new Promise((resolve) => {
        const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } resolve({ killed: true }); }, 5000);
        child.once('exit', (code) => { clearTimeout(timer); resolve({ code }); });
      });
    },
    child,
  };
}

/**
 * The lane relays to the agent.
 *
 * The lane stays the persistent PowerShell worker it already is; this reaches the agent through
 * it, from the lane process, over the agent's named pipe. The point of routing a request this
 * way in a measurement is that it proves the agent is a SECOND ENDPOINT rather than a private
 * channel of the module that started it: the lane process has no handle the agent gave it and
 * no desktop open, and it still gets an answer.
 *
 * There is no cross-desktop call anywhere on this path. The pipe is not desktop-scoped, so this
 * works without any of the reach handling three phases could not make work, and this module
 * never attempts that handling.
 */
export async function relayThroughLane(pipeName, request, options = {}) {
  const mod = await import('./win32.js');
  const envelope = Buffer.from(JSON.stringify({ ...request, token: options.token }), 'utf8').toString('base64');
  const script = [
    '$ErrorActionPreference = "Stop"',
    `$envelope = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String("${envelope}"))`,
    `$client = New-Object System.IO.Pipes.NamedPipeClientStream(".", "${pipeName}", [System.IO.Pipes.PipeDirection]::InOut)`,
    '$client.Connect(20000)',
    '$writer = New-Object System.IO.StreamWriter($client, (New-Object System.Text.UTF8Encoding($false)), 4096, $true)',
    '$writer.AutoFlush = $true',
    '$reader = New-Object System.IO.StreamReader($client, (New-Object System.Text.UTF8Encoding($false)), $false, 4096, $true)',
    '$writer.WriteLine($envelope)',
    '$answer = $reader.ReadLine()',
    'Write-Output ("NMRELAY " + $answer)',
    // NamedPipeClientStream has no Disconnect method on .NET Framework - only the SERVER stream
    // does - and calling one that is not there threw before the answer was returned. Dispose is
    // the whole cleanup a client needs.
    '$client.Dispose()',
  ].join('\n');
  const raw = await mod.runInLane(options.lane || 'windows', script, options.timeoutMs || 60000);
  const parsed = markedJson(raw.output, 'NMRELAY ');
  if (!parsed.ok) return { ok: false, error: raw.error || parsed.reason, output: String(raw.output || '').slice(-2000) };
  return { ok: true, value: parsed.value };
}

/** A hash of a file, for evidence that two captures are two different states. */
export function fileDigest(file) {
  try {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}
