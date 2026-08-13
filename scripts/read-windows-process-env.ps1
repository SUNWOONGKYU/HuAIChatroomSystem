param([Parameter(Mandatory=$true)][int]$ProcessId)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class WinProcEnv {
  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_BASIC_INFORMATION {
    public IntPtr Reserved1;
    public IntPtr PebBaseAddress;
    public IntPtr Reserved2_0;
    public IntPtr Reserved2_1;
    public IntPtr UniqueProcessId;
    public IntPtr Reserved3;
  }

  [DllImport("ntdll.dll")]
  public static extern int NtQueryInformationProcess(IntPtr processHandle, int processInformationClass, ref PROCESS_BASIC_INFORMATION processInformation, int processInformationLength, out int returnLength);

  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern IntPtr OpenProcess(UInt32 desiredAccess, bool inheritHandle, UInt32 processId);

  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool ReadProcessMemory(IntPtr processHandle, IntPtr baseAddress, byte[] buffer, UIntPtr size, out UIntPtr bytesRead);

  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool CloseHandle(IntPtr handle);
}
"@

$PROCESS_QUERY_LIMITED_INFORMATION = [UInt32]0x1000
$PROCESS_VM_READ = [UInt32]0x0010
function Read-Ptr([IntPtr]$Handle, [IntPtr]$Address) {
  $buffer = New-Object byte[] 8
  $read = [UIntPtr]::Zero
  if (-not [WinProcEnv]::ReadProcessMemory($Handle, $Address, $buffer, [UIntPtr]([UInt64]8), [ref]$read)) { throw "read-ptr-failed" }
  return [IntPtr]([BitConverter]::ToInt64($buffer, 0))
}

function Read-RemoteBytesUntilDoubleNull([IntPtr]$Handle, [IntPtr]$Address, [int]$MaxBytes) {
  $all = New-Object System.Collections.Generic.List[byte]
  $offset = 0
  $chunkSize = 4096
  while ($offset -lt $MaxBytes) {
    $size = [Math]::Min($chunkSize, $MaxBytes - $offset)
    $buffer = New-Object byte[] $size
    $read = [UIntPtr]::Zero
    if (-not [WinProcEnv]::ReadProcessMemory($Handle, [IntPtr]($Address.ToInt64() + $offset), $buffer, [UIntPtr]([UInt64]$size), [ref]$read)) { break }
    $n = [int]$read.ToUInt64()
    if ($n -le 0) { break }
    for ($i=0; $i -lt $n; $i++) { $all.Add($buffer[$i]) }
    $count = $all.Count
    if ($count -ge 4 -and $all[$count-1] -eq 0 -and $all[$count-2] -eq 0 -and $all[$count-3] -eq 0 -and $all[$count-4] -eq 0) { break }
    $offset += $n
  }
  return $all.ToArray()
}


$handle = [WinProcEnv]::OpenProcess($PROCESS_QUERY_LIMITED_INFORMATION -bor $PROCESS_VM_READ, $false, [UInt32]$ProcessId)
if ($handle -eq [IntPtr]::Zero) { throw "open-process-failed" }

try {
  $pbi = New-Object WinProcEnv+PROCESS_BASIC_INFORMATION
  $returnLength = 0
  $status = [WinProcEnv]::NtQueryInformationProcess($handle, 0, [ref]$pbi, [Runtime.InteropServices.Marshal]::SizeOf($pbi), [ref]$returnLength)
  if ($status -ne 0) { throw "nt-query-failed:$status" }

  $pointerSize = [IntPtr]::Size
  if ($pointerSize -ne 8) { throw "unsupported-pointer-size:$pointerSize" }

  $processParametersPtr = Read-Ptr $handle ([IntPtr]($pbi.PebBaseAddress.ToInt64() + 0x20))
  if ($processParametersPtr -eq [IntPtr]::Zero) { throw "missing-process-parameters" }

  $environmentPtr = Read-Ptr $handle ([IntPtr]($processParametersPtr.ToInt64() + 0x80))
  if ($environmentPtr -eq [IntPtr]::Zero) { '{}' ; exit 0 }

  $bytes = Read-RemoteBytesUntilDoubleNull $handle $environmentPtr 1048576
  $text = [Text.Encoding]::Unicode.GetString($bytes)
  $result = [ordered]@{}
  foreach ($entry in $text.Split([char]0)) {
    if ([string]::IsNullOrWhiteSpace($entry)) { continue }
    $idx = $entry.IndexOf('=')
    if ($idx -le 0) { continue }
    $key = $entry.Substring(0, $idx)
    $value = $entry.Substring($idx + 1)
    if ($key -match '^[A-Za-z0-9_]+$') { $result[$key] = $value }
  }
  $result | ConvertTo-Json -Compress
}
finally {
  [void][WinProcEnv]::CloseHandle($handle)
}
