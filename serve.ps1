param([int]$Port = 5173)
# Oddiy statik server (Node/Python kerak emas). Ishga tushirish: start.bat
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$mime = @{
  '.html'='text/html'; '.css'='text/css'; '.js'='text/javascript'; '.jsx'='text/javascript';
  '.json'='application/json'; '.txt'='text/plain'; '.svg'='image/svg+xml'; '.ico'='image/x-icon'
}
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "Sayt ishga tushdi: http://localhost:$Port/   (to'xtatish: Ctrl+C)"
try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $path = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath).TrimStart('/')
    if ($path -eq '') { $path = 'index.html' }
    $file = Join-Path $root $path
    $full = [IO.Path]::GetFullPath($file)
    if ($full.StartsWith($root) -and (Test-Path $full -PathType Leaf)) {
      $ext = [IO.Path]::GetExtension($full).ToLower()
      $type = $mime[$ext]; if (-not $type) { $type = 'application/octet-stream' }
      $bytes = [IO.File]::ReadAllBytes($full)
      $ctx.Response.ContentType = "$type; charset=utf-8"
      $ctx.Response.Headers.Add('Cache-Control','no-store')
      $ctx.Response.ContentLength64 = $bytes.Length
      try { $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length) } catch {}
    } else {
      $ctx.Response.StatusCode = 404
    }
    try { $ctx.Response.Close() } catch {}
  }
} finally { $listener.Stop() }
