# Replaces the icon and version resources of a Windows executable using the
# Win32 UpdateResource API (no third-party binaries).
#   -Exe   path to the .exe to modify
#   -Spec  text file, one resource per line: <type>|<id>|<lang>|<file with raw bytes>
# Existing RT_ICON (3), RT_GROUP_ICON (14) and RT_VERSION (16) resources are removed first.
param([Parameter(Mandatory)] [string] $Exe, [Parameter(Mandatory)] [string] $Spec)
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class InkResEdit {
  [DllImport("kernel32", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr LoadLibraryEx(string f, IntPtr h, uint flags);
  [DllImport("kernel32")] static extern bool FreeLibrary(IntPtr h);
  delegate bool EnumNameProc(IntPtr h, IntPtr type, IntPtr name, IntPtr param);
  delegate bool EnumLangProc(IntPtr h, IntPtr type, IntPtr name, ushort lang, IntPtr param);
  [DllImport("kernel32", CharSet = CharSet.Unicode)] static extern bool EnumResourceNames(IntPtr h, IntPtr type, EnumNameProc cb, IntPtr p);
  [DllImport("kernel32", CharSet = CharSet.Unicode)] static extern bool EnumResourceLanguages(IntPtr h, IntPtr type, IntPtr name, EnumLangProc cb, IntPtr p);
  [DllImport("kernel32", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr BeginUpdateResource(string f, bool deleteAll);
  [DllImport("kernel32", SetLastError = true)] static extern bool UpdateResource(IntPtr h, IntPtr type, IntPtr name, ushort lang, byte[] data, uint size);
  [DllImport("kernel32", SetLastError = true)] static extern bool EndUpdateResource(IntPtr h, bool discard);

  class Res { public int Type; public object Name; public ushort Lang; }

  static object NameOf(IntPtr p) {
    if (((ulong)p.ToInt64() >> 16) == 0) return (int)p.ToInt64();
    return Marshal.PtrToStringUni(p);
  }

  static List<Res> Existing(string file, int[] types) {
    var list = new List<Res>();
    IntPtr mod = LoadLibraryEx(file, IntPtr.Zero, 0x22);
    if (mod == IntPtr.Zero) throw new Exception("LoadLibraryEx failed: " + Marshal.GetLastWin32Error());
    try {
      foreach (int t in types) {
        int type = t;
        var names = new List<object>();
        EnumNameProc nameCb = (h, ty, name, p) => { names.Add(NameOf(name)); return true; };
        EnumResourceNames(mod, (IntPtr)type, nameCb, IntPtr.Zero);
        foreach (object n in names) {
          IntPtr namePtr = n is int ? (IntPtr)(int)n : Marshal.StringToHGlobalUni((string)n);
          object captured = n;
          EnumLangProc langCb = (h, ty, nm, lang, p) => { list.Add(new Res { Type = type, Name = captured, Lang = lang }); return true; };
          EnumResourceLanguages(mod, (IntPtr)type, namePtr, langCb, IntPtr.Zero);
          if (!(n is int)) Marshal.FreeHGlobal(namePtr);
        }
      }
    } finally { FreeLibrary(mod); }
    return list;
  }

  public static int Apply(string file, string[] specLines) {
    var old = Existing(file, new int[] { 3, 14, 16 });
    IntPtr h = BeginUpdateResource(file, false);
    if (h == IntPtr.Zero) throw new Exception("BeginUpdateResource failed: " + Marshal.GetLastWin32Error());
    bool ok = false;
    try {
      foreach (Res r in old) {
        IntPtr namePtr = r.Name is int ? (IntPtr)(int)r.Name : Marshal.StringToHGlobalUni((string)r.Name);
        if (!UpdateResource(h, (IntPtr)r.Type, namePtr, r.Lang, null, 0)) throw new Exception("delete failed: " + Marshal.GetLastWin32Error());
        if (!(r.Name is int)) Marshal.FreeHGlobal(namePtr);
      }
      foreach (string line in specLines) {
        if (line.Trim().Length == 0) continue;
        string[] f = line.Split('|');
        byte[] data = System.IO.File.ReadAllBytes(f[3]);
        if (!UpdateResource(h, (IntPtr)int.Parse(f[0]), (IntPtr)int.Parse(f[1]), ushort.Parse(f[2]), data, (uint)data.Length))
          throw new Exception("add failed: " + Marshal.GetLastWin32Error());
      }
      ok = true;
    } finally {
      if (!EndUpdateResource(h, !ok)) throw new Exception("EndUpdateResource failed: " + Marshal.GetLastWin32Error());
    }
    return old.Count;
  }
}
'@

$removed = [InkResEdit]::Apply((Resolve-Path $Exe).Path, (Get-Content -LiteralPath $Spec))
Write-Output "  replaced $removed existing icon/version resources"

