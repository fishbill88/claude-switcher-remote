# Builds the web app and publishes it to the vault server, which serves it at /api/app/ (and /app/ where the proxy
# forwards it). No sudo or password: the server's user owns the releases folder (claude-account-switcher's
# server/release-access.sh, run once by an admin). The new build is uploaded aside and swapped in, so the live app is
# never half-copied.
param([string]$Server = 'biloy')
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$dir = '/opt/claude-vault/releases'

Push-Location $root
try {
  npm test
  if ($LASTEXITCODE) { throw 'Tests failed.' }
  npm run build
  if ($LASTEXITCODE) { throw 'Build failed.' }

  # -n and BatchMode: Windows' OpenSSH would otherwise wait on stdin or ask for a password.
  ssh -n -o BatchMode=yes $Server "test -w $dir && rm -rf $dir/web.new"
  if ($LASTEXITCODE) { throw "Can't write to $dir on $Server." }
  scp -q -r -o BatchMode=yes dist "${Server}:$dir/web.new"
  if ($LASTEXITCODE) { throw 'Upload failed.' }
  # Exact permissions, never what scp carried over from Windows: a page others could rewrite could steal vault keys.
  ssh -n -o BatchMode=yes $Server "set -e; cd $dir; chmod -R u=rwX,g=rX,o=rX web.new; rm -rf web.old; if [ -d web ]; then mv web web.old; fi; mv web.new web; rm -rf web.old; test `$(find web -perm /o+w | wc -l) -eq 0"
  if ($LASTEXITCODE) { throw 'Swapping the new build in failed.' }
  Write-Host 'Published. Open https://claude-vault.138-2-82-127.sslip.io/api/app/'
} finally {
  Pop-Location
}
