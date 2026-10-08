#!/usr/bin/env bash
# Frozen gate: three sandbox probes (cross-pds, linked-session, private-rsvp) run on the https
# devnet and give the answers they gave on the http devnet on 2026-10-05. Do not edit after the gate
# commit. URLs come from the devnet's data/devnet.env, there is no allowHttp, and the browser reaches
# devnet names on this machine and trusts exactly the devnet's leaf key, through one shared helper.
# The run is the scratch https stack (compose project devnet-scratch) built by the atproto-devnet
# worktree below; the shared devnet-spaces is never touched. Every check asserts a positive artifact.
# Run from anywhere: sandbox/opensocial/verify.sh. SKIP_LIVE=1 runs checks 0-5 only.
set -uo pipefail
cd "$(dirname "$0")/../.."

BASE=a24fe1e43
SB=sandbox/opensocial
DEVNET=${DEVNET_DIR:-/workspaces/scratch/wt-atproto-devnet-shared-https}
DEVNET_MIN=606e7d0
P=devnet-scratch
DENV=$DEVNET/data/devnet.env
ACC=$DEVNET/data/accounts.env
LEAF=$DEVNET/data/https/leaf.crt
CA=$DEVNET/data/https/ca.crt
PROPOSAL=${PROPOSAL_LEXICONS:-/workspaces/scratch/opensocial-proposal/lexicons}
export ATCUTE_DIR=${ATCUTE_DIR:-/workspaces/scratch/wt-atmo-events-opensocial/apps/web/node_modules/@atcute}
export PLAYWRIGHT_MODULE=${PLAYWRIGHT_MODULE:-/home/node/.local/share/mise/installs/npm-playwright/1.63.0/node_modules/playwright}
PROBES="probe-cross-pds.mjs probe-linked-session.mjs probe-private-rsvp.mjs"
HELPER=$SB/devnet-browser.mjs
T=$(mktemp -d /tmp/stage2-uc-verify.XXXXXX)
pass=0; fail=0
ok() { echo "PASS $*"; pass=$((pass+1)); }
no() { echo "FAIL $*"; fail=$((fail+1)); }
finish() { echo "TALLY $pass passed, $fail failed"; [ "$fail" -eq 0 ]; exit $?; }
# the answer of verdict <id> in a probe log: the text after the last " -> " on "- <id>: ..."
ans() { sed -n '/^## verdicts/,$p' "$1" | awk -v id="$2" 'index($0, "- " id ": ") == 1 { n = split($0, a, " -> "); v = a[n] } END { print v }'; }
# cross-pds: the value of <step> for the member whose results heading starts with <handle>
row() { sed -n '/^## results/,$p' "$1" | awk -v h="$2" -v s="$3" '
  /^- / { cur = (index($0, "- " h " ") == 1) } cur && index($0, "    " s ": ") == 1 { sub("^    " s ": ", ""); print; exit }'; }
norm() { sed -E 's/did:plc:[a-z2-7]{24}/DID/g'; }

# 0. base
if git merge-base --is-ancestor $BASE HEAD && [ "$(git branch --show-current)" = sandbox/https-devnet ]; then
  ok "0 HEAD $(git rev-parse --short HEAD) on sandbox/https-devnet contains $BASE"
else no "0 branch '$(git branch --show-current)' (sandbox/https-devnet), contains $BASE: $(git merge-base --is-ancestor $BASE HEAD && echo yes || echo no)"; fi

# 1. touch-set: only the three probes, the new helper and the README (this gate aside), each probe
#    changed; the other probes, seed-lexicons and everything outside sandbox/opensocial unchanged
changed=$(git diff --name-only $BASE HEAD -- . ":!$SB/verify.sh" | LC_ALL=C sort)
allowed=$(printf '%s\n' $SB/README.md $SB/devnet-browser.mjs $SB/probe-cross-pds.mjs $SB/probe-linked-session.mjs $SB/probe-private-rsvp.mjs | LC_ALL=C sort)
extra=$(comm -23 <(echo "$changed") <(echo "$allowed") | grep . | tr '\n' ' ')
nprobe=0; for f in $PROBES; do echo "$changed" | grep -qx "$SB/$f" && nprobe=$((nprobe+1)); done
frozen=$(git diff --numstat $BASE HEAD -- $SB/probe-events-space.mjs $SB/probe-space-blob.mjs $SB/probe-typed-scope.mjs $SB/seed-lexicons.mjs | wc -l)
dirty=$(git status --porcelain -- . ":!$SB/verify.sh" | wc -l)
if [ -z "$extra" ] && [ "$nprobe" -eq 3 ] && [ -f "$HELPER" ] && [ "$frozen" -eq 0 ] && [ "$dirty" -eq 0 ]; then
  ok "1 touch-set: $(echo $changed | wc -w) files, 3 of 3 probes changed, helper present, 4 frozen files unchanged, tree clean"
else no "1 outside the set: [$extra]; probes changed $nprobe (3); helper $( [ -f "$HELPER" ] && echo present || echo missing); frozen files changed $frozen (0); uncommitted $dirty (0)"; fi

# 2. hygiene in the three probes and the helper: no allowHttp, no http/ws localhost default, no
#    blanket TLS bypass, no bare browser launch; commits carry no bead id or attribution
files="$HELPER $(printf "$SB/%s " $PROBES)"
c_http=$(cat $files 2>/dev/null | grep -c 'allowHttp')
# (the OAuth loopback redirect on http://127.0.0.1 is the protocol's own, so it stays)
c_local=$(cat $files 2>/dev/null | grep -cE "(http|ws)://localhost|:(3010|3020|3030|2582|6008)\b")
c_tls=$(cat $files 2>/dev/null | grep -cE 'NODE_TLS_REJECT_UNAUTHORIZED|rejectUnauthorized|ignoreHTTPSErrors|--ignore-certificate-errors($|[^-])')
c_launch=$(cat $(printf "$SB/%s " $PROBES) 2>/dev/null | grep -c 'chromium\.launch(')
c_msg=$(git log --format=%B $BASE..HEAD | grep -ciE '\bom-[a-z0-9]{4,}|co-authored|claude|anthropic|generated with')
if [ "$c_http" -eq 0 ] && [ "$c_local" -eq 0 ] && [ "$c_tls" -eq 0 ] && [ "$c_launch" -eq 0 ] && [ "$c_msg" -eq 0 ]; then
  ok "2 allowHttp 0, localhost URLs 0, TLS bypass 0, bare chromium.launch 0 in the probes, bead ids/attribution 0"
else no "2 allowHttp $c_http, localhost URLs $c_local, TLS bypass $c_tls, bare chromium.launch $c_launch, bead ids/attribution $c_msg (all 0)"; fi

# 3. the helper pins exactly the leaf's key: leafSpki(file) equals openssl's SPKI hash, and its
#    launch passes the pin and the host mapping, not a blanket bypass
want=$(openssl x509 -in "$LEAF" -pubkey -noout 2>/dev/null | openssl pkey -pubin -outform der 2>/dev/null | openssl dgst -sha256 -binary | base64)
got=$(node --input-type=module -e "const m = await import(process.argv[1]); console.log(m.leafSpki(process.argv[2]))" "$PWD/$HELPER" "$LEAF" 2>/dev/null)
cag=$(node --input-type=module -e "const m = await import(process.argv[1]); console.log(m.leafSpki(process.argv[2]))" "$PWD/$HELPER" "$CA" 2>/dev/null)
c_pin=$(grep -c -- '--ignore-certificate-errors-spki-list' "$HELPER" 2>/dev/null); c_map=$(grep -c -- '--host-resolver-rules' "$HELPER" 2>/dev/null)
c_exp=$(grep -cE '^export (async )?function (leafSpki|launchBrowser)\(' "$HELPER" 2>/dev/null)
if [ -n "$want" ] && [ "$got" = "$want" ] && [ -n "$cag" ] && [ "$cag" != "$want" ] && [ "$c_pin" -ge 1 ] && [ "$c_map" -ge 1 ] && [ "$c_exp" -eq 2 ]; then
  ok "3 leafSpki(leaf.crt) = openssl $want; the CA's key hashes differently; helper passes the pin and the host mapping; exports leafSpki and launchBrowser"
else no "3 leafSpki '$got' vs openssl '$want'; CA '$cag'; pin flag $c_pin, host-resolver-rules $c_map, exports $c_exp (2)"; fi

# No probe is started while any of them still carries a localhost default: those are devnet-spaces'
# ports, so a run would write to the shared stack (it did once, at spec time, 2026-10-08).
safe=0; [ "$c_local" -eq 0 ] && [ "$nprobe" -eq 3 ] && safe=1

# 4. URLs are required: with the devnet's URL variables unset, each probe stops at once, naming one
reqok=0; reqs=""
[ "$safe" -eq 1 ] && for f in $PROBES; do
  ( unset ALPHA_PDS_URL PDS_URL REGULAR_PDS_URL PROD_PDS_URL PLC_URL JETSTREAM_URL DEVNET_CA_FILE DEVNET_LEAF_FILE
    timeout 30 node $SB/$f ) > $T/req-$f.out 2>&1; echo $? > $T/req-$f.rc
done
[ "$safe" -eq 1 ] && for f in $PROBES; do rc=$(cat $T/req-$f.rc); v=$(grep -oE '[A-Z_]+_(URL|FILE) is required' $T/req-$f.out | head -1)
  [ "$rc" -ne 0 ] && [ "$rc" -ne 124 ] && [ -n "$v" ] && reqok=$((reqok+1)); reqs="$reqs ${f#probe-}:rc=$rc:'$v'"; done
if [ "$reqok" -eq 3 ]; then ok "4 without the devnet's env each probe exits non-zero naming a variable:$reqs"
elif [ "$safe" -eq 0 ]; then no "4 not run: localhost defaults remain ($c_local) or not every probe is changed"
else no "4 $reqok of 3 probes refuse to run without URLs:$reqs"; fi

# 5. devnet-spaces untouched (container start times as stamped 2026-10-08), and the devnet tools
#    this gate uses are at least $DEVNET_MIN
expected='/devnet-spaces-jetstream-1 2026-10-05T16:14:38.743036991Z
/devnet-spaces-maildev-1 2026-10-05T16:08:39.348764504Z
/devnet-spaces-pds-1 2026-10-05T16:14:21.241220654Z
/devnet-spaces-pds-prod-1 2026-10-05T16:14:38.289594138Z
/devnet-spaces-pds-regular-1 2026-10-05T16:14:38.40683215Z
/devnet-spaces-plc-1 2026-10-05T16:08:43.259658476Z
/devnet-spaces-postgres-1 2026-10-05T16:08:39.566475504Z
/devnet-spaces-relay-1 2026-10-05T16:14:37.98718671Z
/devnet-spaces-tap-1 2026-10-05T16:14:43.614557134Z'
actual=$(docker inspect -f '{{.Name}} {{.State.StartedAt}}' $(docker compose -p devnet-spaces ps -q 2>/dev/null) 2>/dev/null | LC_ALL=C sort)
if [ "$actual" = "$expected" ] && git -C "$DEVNET" merge-base --is-ancestor $DEVNET_MIN HEAD 2>/dev/null; then
  ok "5 devnet-spaces: 9 containers, start times unchanged; devnet tools at $(git -C "$DEVNET" rev-parse --short HEAD) (contains $DEVNET_MIN)"
else no "5 devnet-spaces start times changed or missing: [$(echo "$actual" | tr '\n' ' ')]; devnet tools contain $DEVNET_MIN: $(git -C "$DEVNET" merge-base --is-ancestor $DEVNET_MIN HEAD 2>/dev/null && echo yes || echo no)"; fi

[ "${SKIP_LIVE:-}" = 1 ] && finish
if [ "$safe" -eq 0 ] || [ "$reqok" -ne 3 ]; then
  for n in 6 7 8 9 10 11; do no "$n not run: checks 2 and 4 must show no localhost default and URLs required first"; done
  finish
fi

# 6. the scratch stack is up, and the proposal's 40 lexicons are in its authority (the devnet's own
#    tool, idempotent; a first run publishes, later runs find them unchanged)
up=$(docker compose -p $P ps --status running -q 2>/dev/null | wc -l)
( cd "$DEVNET" && ./scripts/https-lexicons.sh "$PROPOSAL" ) > $T/lex.out 2> $T/lex.err; lexrc=$?
nsids=$(grep -c '^group\.opensocial\.' $T/lex.out); lexline=$(grep -E 'published, [0-9]+ unchanged' $T/lex.err | tail -1)
if [ "$up" -eq 10 ] && [ "$lexrc" -eq 0 ] && [ "$nsids" -eq 40 ]; then ok "6 $P: 10 services running; lexicons: 40 group.opensocial NSIDs; $lexline"
else no "6 $P running $up (10); https-lexicons rc $lexrc, NSIDs $nsids (40): $(tail -2 $T/lex.err | tr '\n' ' ')"; fi

# The live runs: each probe under https-run with only the devnet's env (devnet.env plus
# accounts.env), traced for connect(2) inside the devnet's hosts mapping.
LG=lg$(date +%s).devnet.test
NAMES="alice.devnet.test bob.devnet.test probe-group.devnet.test carol.regular.devnet.test dave.prod.devnet.test rsvp-group.devnet.test erin.devnet.test frank.devnet.test linked-group.devnet.test $LG"
run_probe() { local f=$1; shift
  ( set -a; . "$DENV"; . "$ACC"; set +a
    export INVITE_CODE="$DEVNET_INVITE_CODE" PROBE_OUT="$T/out-$f" "$@"
    mkdir -p "$T/out-$f"
    HTTPS_RUN_EXTRA_NAMES="$NAMES" timeout 900 "$DEVNET/scripts/https-run" \
      strace -f -qq --seccomp-bpf -e trace=connect -o "$T/trace-$f" node "$SB/$f" ) > "$T/$f.log" 2>&1
  echo $? > "$T/$f.rc"; }

# 7. probe-cross-pds: members on three PDS builds and a group on the alpha
run_probe probe-cross-pds.mjs
L=$T/probe-cross-pds.mjs.log; bad=""
chk() { local v; v=$(row $L "$1" "$2" | norm); echo "$v" | grep -qE "$3" || bad="$bad $1/$2='$v'"; }
chk alice.devnet.test A '^200$'; chk alice.devnet.test B '^200$'; chk alice.devnet.test Dw '^200$'
chk alice.devnet.test C '^granted: atproto space:group\.opensocial\.members\?authority=DID&skey=self&collection=group\.opensocial\.acceptance&action=create&action=update&action=delete$'
chk alice.devnet.test D '^granted: atproto space:\*\?authority=DID&collection=group\.opensocial\.acceptance&action=create&action=update&action=delete$'
for m in carol.regular.devnet.test dave.prod.devnet.test; do
  chk $m A '^200$'; chk $m B '^([013-9][0-9]{2}|2[1-9][0-9]|20[1-9])( |$)'; chk $m C '^granted: atproto$'; chk $m D '^granted: atproto$'; chk $m Dw '^403 ScopeMissingError$'; done
rc=$(cat $T/probe-cross-pds.mjs.rc)
if [ "$rc" -eq 0 ] && [ -z "$bad" ]; then
  ok "7 cross-pds: alice A/B/Dw 200 and both scopes granted as asked; carol B '$(row $L carol.regular.devnet.test B)', dave B '$(row $L dave.prod.devnet.test B)'; both granted atproto only, Dw 403 ScopeMissingError"
else no "7 cross-pds exit $rc; differs from the http answers:$bad"; fi

# 8. probe-linked-session, as a group made for this run
run_probe probe-linked-session.mjs GROUP_HANDLE=$LG
L=$T/probe-linked-session.mjs.log; bad=""
v8() { local v; v=$(ans $L "$1" | norm); echo "$v" | grep -qE "$2" || bad="$bad $1='$v'"; }
v8 P0 '^YES \(400 RecordNotFound\)$'; v8 S '^YES$'
v8 L1 '^members/self 200; events first 200; repeat 400 SpaceAlreadyExists$'
v8 L2 '^200$'; v8 L3 '^200$'; v8 L4 '^200$'; v8 L5 '^200$'
v8 L6 '^linked 200, members-only seen; anonymous repo: public seen, members-only not seen; anonymous space 401 AuthMissing$'
v8 L7 '^scope unchanged; write 200$'
v8 J '^1 commits; public event seen; members-only events not seen; access or index entry none$'
rc=$(cat $T/probe-linked-session.mjs.rc)
if [ "$rc" -eq 0 ] && [ -z "$bad" ]; then ok "8 linked-session as $LG: P0 S L1-L7 J as on http; J: $(ans $L J)"
else no "8 linked-session exit $rc; differs from the http answers:$bad"; fi

# 9. probe-private-rsvp
run_probe probe-private-rsvp.mjs
L=$T/probe-private-rsvp.mjs.log; bad=""
v8 S '^members-only event at://DID/space/net\.openmeet\.space\.events/self/DID/community\.lexicon\.calendar\.event/[a-z2-7]{13}; listed: alice, bob, carol; not listed: erin, frank$'
v8 R1 '^scope granted; write 200$'; v8 R2 '^scope granted; write 200$'
v8 R3 '^scope DROPPED \(atproto only\); write 403 ScopeMissingError$'; v8 R1p '^YES, none$'
v8 R4 '^listRepos 200 \[(rsvp-group, alice|alice, rsvp-group)\]; alice going; erin going; carol 400 InvalidToken$'
v8 R5 '^200$'; v8 R6 '^YES \(getSpaceCredential 400 UserNotAuthorized\)$'; v8 R7 '^401 AuthMissing$'
v8 R8 '^403 ScopeMissingError$'; v8 R9 '^write 200; group now reads notgoing$'; v8 P '^event 200; RSVP 200$'
v8 J "^[0-9]+ commits on the stream; this run's public control: 2 of 2; from the space: none$"
rc=$(cat $T/probe-private-rsvp.mjs.rc)
if [ "$rc" -eq 0 ] && [ -z "$bad" ]; then ok "9 private-rsvp: S R1-R9 R1p P J as on http; J: $(ans $L J)"
else no "9 private-rsvp exit $rc; differs from the http answers:$bad"; fi

# 10. nothing left the machine, and nothing reached devnet-spaces: across the three runs, every
#     connect(2) to an IP address went to loopback, and none to a port devnet-spaces publishes.
#     Chromium's IPv6 reachability check (a UDP connect to 2001:4860:4860::8888 that sends nothing)
#     is the one non-loopback connect allowed.
nconn=$(cat $T/trace-* 2>/dev/null | grep -cE 'sin6?_addr|inet_addr|inet_pton')
outside=$(cat $T/trace-* 2>/dev/null | grep -oE 'inet_addr\("[0-9.]+"\)|inet_pton\(AF_INET6, "[0-9a-f:.]+"' | grep -vE '"127\.|"::1"|"::ffff:127\.|"2001:4860:4860::8888"' | LC_ALL=C sort | uniq -c | tr '\n' ' ')
spaces=$(cat $T/trace-* 2>/dev/null | grep -oE 'htons\((1026|1081|2470|2480|2592|3010|3020|3030|5433|6008)\)' | LC_ALL=C sort | uniq -c | tr '\n' ' ')
if [ "$nconn" -gt 0 ] && [ -z "$outside" ] && [ -z "$spaces" ]; then ok "10 traces: $nconn IP connects, all to loopback; 0 elsewhere; 0 to devnet-spaces' ports"
else no "10 IP connects $nconn (> 0); non-loopback: [$outside]; to devnet-spaces' ports: [$spaces]"; fi

# 11. the cookbook runs these three on the https devnet: https-run, devnet.env, the helper's leaf
#     setting, and each probe named in that section
sec=$(awk '/^## .*[Hh]ttps/ { on = 1; print; next } /^## / { on = 0 } on' $SB/README.md)
c_sec=0; for w in https-run devnet.env DEVNET_LEAF_FILE probe-cross-pds probe-linked-session probe-private-rsvp; do echo "$sec" | grep -q -- "$w" && c_sec=$((c_sec+1)); done
c_alow=$(echo "$sec" | grep -c 'allowHttp')
if [ "$c_sec" -eq 6 ] && [ "$c_alow" -eq 0 ]; then ok "11 README: an https section names https-run, devnet.env, DEVNET_LEAF_FILE and the three probes"
else no "11 README https section: $c_sec of 6 terms; allowHttp mentions $c_alow (0)"; fi

finish
