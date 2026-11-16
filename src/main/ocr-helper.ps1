# Persistent OCR worker (Windows.Media.Ocr).
#
# Why a resident process: spawning powershell.exe costs 300-500ms, and WinRT
# activation + engine creation adds another 100-300ms. Keeping one process and
# one warm OcrEngine makes a single recognition ~50ms instead of ~800ms.
#
# Protocol (one command per line, one reply line per command):
#   -> ping          <- {"ok":true,"kind":"ready"}
#   -> langs         <- {"ok":true,"kind":"langs","langs":["zh-Hans-CN",...]}
#   -> ocr <path>    <- {"ok":true,"kind":"ocr","b64":"...","lines":3,"ms":52,"lang":"zh-Hans-CN"}
#                   <- {"ok":false,"kind":"ocr","error":"no-engine"}
#                   <- {"ok":false,"kind":"ocr","error":"<message>"}
#
# IMPORTANT: text is returned as Base64 of UTF-8, NOT raw. powershell.exe writes
# redirected stdout in the OEM code page (GBK on zh-CN Windows), so any non-ASCII
# character would be corrupted before Node ever sees it. Base64 keeps the whole
# reply pure ASCII and sidesteps console encoding completely.
#
# All comments and literals here are ASCII on purpose: this file is written as
# UTF-8 without BOM, and Windows PowerShell 5.1 would decode non-ASCII bytes as
# ANSI, which can corrupt string literals.

$ErrorActionPreference = "Stop"

# This assembly provides [System.WindowsRuntimeSystemExtensions], which the
# await shim below depends on. Without this line the type lookup throws
# "Unable to find type" and the whole helper dies on startup.
Add-Type -AssemblyName System.Runtime.WindowsRuntime

# Load WinRT types. The [Type, Assembly, ContentType] form is what makes the
# projection available in Windows PowerShell 5.1.
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime]

# Await an IAsyncOperation<T> synchronously. There is no built-in .GetResult()
# in PS 5.1, so grab the generic AsTask<T>(IAsyncOperation<T>) method and block.
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq "AsTask" -and
    $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq "IAsyncOperation``1"
  })[0]

function Await($operation, [Type]$resultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($resultType)
  $task = $asTask.Invoke($null, @($operation))
  $task.Wait(-1) | Out-Null
  $task.Result
}

# Build one warm engine per installed recognizer language. Building them at
# startup is the whole point of a resident helper.
$script:engines = @{}
$script:order = @()

foreach ($tag in @("en-US", "zh-Hans-CN")) {
  try {
    $language = New-Object Windows.Globalization.Language $tag
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
    if ($null -ne $engine) {
      $script:engines[$tag] = $engine
      $script:order += $tag
    }
  } catch {
    # language pack not installed -> simply skip it
  }
}

# If neither preferred tag exists, fall back to whatever the system offers
# (e.g. only zh-Hans-CN installed, or a different locale).
if ($script:order.Count -eq 0) {
  foreach ($language in [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages) {
    try {
      $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
      if ($null -ne $engine) {
        $script:engines[$language.LanguageTag] = $engine
        $script:order += $language.LanguageTag
      }
    } catch {
    }
  }
}

function Invoke-OcrWith($engine, [string]$path) {
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  try {
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    $lines = @()
    foreach ($line in $result.Lines) { $lines += $line.Text }
    return $lines
  } finally {
    $stream.Dispose()
  }
}

# Collapse the spaces Windows OCR injects between CJK glyphs. It always stores
# Chinese as one glyph per token separated by spaces (e.g. "ni hao shi jie"
# style gaps), which looks broken in the panel and wastes tokens. Only spaces
# that sit BETWEEN two CJK characters are removed, so the space in
# "Transformer <cjk>" (latin -> CJK boundary) is preserved.
$cjk = "\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef"
$spaceBetweenCjk = [regex]"(?<=[$cjk])[ \t]+(?=[$cjk])"

function Repair-Spacing([string]$line) {
  if ($null -eq $line) { return "" }
  return $spaceBetweenCjk.Replace($line, "")
}

function Test-HasCjk([string]$text) {
  return [regex]::IsMatch($text, "[\u4e00-\u9fff]")
}

function Reply($object) {
  $json = $object | ConvertTo-Json -Compress -Depth 4
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}

function Reply-Text([string]$text, [int]$lineCount, [int]$ms, [string]$lang, [bool]$upscaled) {
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($text)
  Reply @{
    ok       = $true
    kind     = "ocr"
    b64      = [System.Convert]::ToBase64String($bytes)
    lines    = $lineCount
    ms       = $ms
    lang     = $lang
    upscaled = $upscaled
  }
}

# Tell the parent we are ready.
[Console]::Out.WriteLine('{"ok":true,"kind":"ready"}')
[Console]::Out.Flush()

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line -eq "") { continue }

  if ($line -eq "ping") {
    Reply @{ ok = $true; kind = "ready" }
    continue
  }

  if ($line -eq "langs") {
    Reply @{ ok = $true; kind = "langs"; langs = @($script:order) }
    continue
  }

  if ($line -like "ocr *") {
    if ($script:order.Count -eq 0) {
      Reply @{ ok = $false; kind = "ocr"; error = "no-engine" }
      continue
    }
    $path = $line.Substring(4).Trim()
    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    try {
      # First pass: the primary engine (zh-Hans-CN handles CJK + Latin).
      $primaryTag = $script:order[0]
      $lines = Invoke-OcrWith $script:engines[$primaryTag] $path
      $joined = ($lines -join "`n")

      # If the crop turned out to be pure Latin (no CJK at all) and a Latin
      # engine exists, redo it: en-US is markedly better on English text.
      if (-not (Test-HasCjk $joined)) {
        foreach ($tag in $script:order) {
          if ($tag -like "en*") {
            $lines = Invoke-OcrWith $script:engines[$tag] $path
            $primaryTag = $tag
            break
          }
        }
      }

      $clean = @()
      foreach ($l in $lines) {
        $fixed = Repair-Spacing $l
        if ($fixed.Trim() -ne "") { $clean += $fixed.Trim() }
      }
      $watch.Stop()

      Reply-Text ($clean -join "`n") $clean.Count $watch.ElapsedMilliseconds $primaryTag $false
    } catch {
      Reply @{ ok = $false; kind = "ocr"; error = ([string]$_.Exception.Message); ms = $watch.ElapsedMilliseconds }
    }
    continue
  }

  Reply @{ ok = $false; kind = "unknown" }
}
