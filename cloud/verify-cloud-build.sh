#!/usr/bin/env sh
# verify-cloud-build.sh — channel-B assertion that the cloud images actually
# BUILD and their git-sourced deps actually RESOLVE + RUN. Catches the class
# of bug that a git-tree-equality check cannot: a tree can be byte-identical
# and `docker build` still fail (dead git tag, missing git in the base image),
# or build green yet fail at runtime (tarball dep with no compiled dist/).
#
# Run from a fresh --no-local clone:  sh cloud/verify-cloud-build.sh
# Exit 0 = all three cloud images build AND the two assertions below hold.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"

echo "[verify] 1/3 building settle-worker image (no cache)…"
docker build --no-cache -t settle-worker-verify "$HERE/settle-worker"

echo "[verify] runtime assertion: @tlay/hashanchor-client resolves and exports HashAnchor…"
# Build-green is NOT enough: a tarball-form dep installs green but ships no
# compiled dist/, so the import throws ERR_MODULE_NOT_FOUND at runtime. Assert
# the actual import + that HashAnchor is a function.
docker run --rm settle-worker-verify node -e \
  "import('@tlay/hashanchor-client').then(m=>{ if(typeof m.HashAnchor!=='function'){console.error('FAIL: HashAnchor is '+typeof m.HashAnchor);process.exit(1)} console.log('OK: @tlay/hashanchor-client imports, HashAnchor is a function'); }).catch(e=>{console.error('FAIL import:',e.message);process.exit(1)})"

echo "[verify] runtime assertion: the SDK resolves each network to its OWN Gateway…"
# The pin exists to fix one thing: eip155:5042 (Arc Mainnet) used to resolve to
# the TESTNET Gateway address. A wrong verifyingContract does not fail loudly —
# the signature recovers to some other address and Circle refuses the
# settlement with nothing pointing at the cause. Checking the resolved sha
# proves which code is installed; only this checks what it DOES. Assert the
# rule (every mainnet one deployment, every testnet another, never equal),
# not just the constants.
docker run --rm settle-worker-verify node -e \
  "import('@tlay/hashanchor-client').then(m=>{
     const vc = n => m.buildSettlePayload(
       { value:1, to:'0x'+'0'.repeat(40), from:'0x'+'0'.repeat(40),
         sig:'0x', nonce:'0x'+'0'.repeat(64), validAfter:0, validBefore:0 },
       { network:n }).paymentRequirements.extra.verifyingContract;
     const MAIN='0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE';
     const TEST='0x0077777d7EBA4688BDeF3E311b846F25870A19B9';
     const a=vc('eip155:5042'), b=vc('eip155:5042002');
     let ok=true;
     if(a!==MAIN){console.error('FAIL: Arc Mainnet resolves to '+a);ok=false}
     if(b!==TEST){console.error('FAIL: Arc Testnet resolves to '+b);ok=false}
     if(a===b){console.error('FAIL: mainnet and testnet share a Gateway address');ok=false}
     if(ok) console.log('OK: eip155:5042 -> '+a+' ; eip155:5042002 -> '+b);
     process.exit(ok?0:1);
   }).catch(e=>{console.error('FAIL import:',e.message);process.exit(1)})"

echo "[verify] 2/3 building burn-intent-worker image (no cache)…"
docker build --no-cache -t burn-intent-worker-verify "$HERE/burn-intent-worker"

echo "[verify] 3/3 building web image (no cache)…"
# The web image is the one that compiles Next; a dependency bump that breaks
# the build shows up here and nowhere else.
docker build --no-cache -t web-verify "$HERE/web"

echo "[verify] all three cloud images build; settle-worker import + Gateway-address assertions PASSED"
