# Agent-to-Agent Payment Flow (Pure Conversation)

> Source: Complete flow script designed by Boss on 2026-02-15

## Flow Overview

```
START → Capability Check → Settlement Negotiation → Onboarding → Service Request → Quote → Payment → Verification → Delivery → Receipt → END
```

## Two-Layer Expression

- **Conversation Layer (Required)**: What the two bots actually say
- **Optional Marker Layer (Recommended)**: Add a minimal "status marker" at the end of a message for programmatic parsing/logging

---

## 0) START

**BuyerBot (Payer)**:
I'd like to purchase a video generation service.

**SellerBot (Payee)**:
Sure. First, let me confirm: do you currently have the ability to pay USDC on-chain (have a wallet and available funds/allowance)?

---

## 1) Capability Check

**BuyerBot**:
I'm not sure. I currently don't have any payment tools installed, and no wallet.

**SellerBot**:
Got it, you don't have payment capability yet. I can guide you step by step to set it up. Once ready, we'll proceed with the quote and transaction.

---

## 2) Settlement Negotiation

**SellerBot**:
Our settlement method is: USDC (on-chain). You just need two things:
1) A wallet address;
2) USDC in your wallet, or a spending allowance from your owner (allowance is recommended).
Can you follow my guidance to set this up?

**BuyerBot**:
Sure, please guide me.

---

## 3) Onboarding (Install/Authorize)

### 3.1 Install & Create Wallet

**SellerBot**:
Step 1: Install the payment module in your environment. Run: `npm install moltspay`.
After installation, create a wallet address and send it to me (address only, never send private key/mnemonic).

**BuyerBot**:
OK, I'm installing and creating the wallet now.

(BuyerBot executes installation and creation)

**BuyerBot**:
I've created my wallet address: 0xBUYER... (example).
`[status:wallet_ready]`

**SellerBot**:
Got it. Reminder: never send your private key/mnemonic to anyone (including me).
Step 2: You need your owner (Boss) to give you payment capability.

---

### 3.2 Get Funds: Two Methods (Transfer / Allowance)

**SellerBot**:
You now have two ways to get payment capability:
A) Have Boss transfer USDC directly to your wallet (simple, but you'll hold the funds);
B) Have Boss give you a "USDC spending allowance" (recommended: you don't hold funds, can only pay within the allowance).
Which works better for you?

**BuyerBot**:
I choose B: have Boss give me an allowance (Permit).

**SellerBot**:
OK. Please send this message to your Boss (you can copy it directly):
"I need a USDC spending allowance (Permit) for purchasing services. Please authorize 10 USDC to my wallet 0xBUYER..., valid for 24 hours."
Let me know when you've received the allowance.

**BuyerBot**:
OK, I'll request authorization from Boss.

(BuyerBot interacts with Boss to complete authorization)

**BuyerBot**:
Boss has completed the authorization. I now have 10 USDC allowance.
`[status:permit_ready USDC=10]`

**SellerBot**:
Great. You now have the payment capability to complete transactions. Let's confirm your service requirements.

---

## 4) Service Request (Confirm Requirements)

**SellerBot**:
Please tell me your video specifications: theme/style, duration, resolution, subtitles or voiceover needed?

**BuyerBot**:
Requirements:
- Theme: A cat surfing on Mars
- Style: Realistic, cinematic feel
- Duration: 5 seconds
- Resolution: 720p
- No subtitles, no voiceover

**SellerBot**:
Got it, I'll generate according to these specs. Here's the final quote and payment method.

---

## 5) Quote (Natural Language + Key Fields)

**SellerBot**:
Quote:
- Service: Video generation (5 sec, 720p)
- Price: 3.99 USDC
- Recipient: 0xb8d6f2441e8f... (example)
- After payment, send me the transaction hash (tx hash) for on-chain verification

Do you confirm the purchase and pay now?

**BuyerBot**:
Confirmed, I'll pay now.

---

## 6) Payment (Buyer Executes & Reports tx)

**BuyerBot**:
I'm completing the 3.99 USDC payment to your address using my wallet.

(BuyerBot calls moltspay to complete payment)

**BuyerBot**:
Payment complete. Transaction hash: 0xABC123... (example).
`[status:payment_sent tx=0xABC123 amount=3.99 USDC]`

---

## 7) Verification (Seller Verifies On-Chain)

**SellerBot**:
I'm verifying the transaction on-chain to confirm receipt and amount.

(SellerBot verifies: to/amount/token/confirmations)

**SellerBot**:
Verification passed: received 3.99 USDC. Starting video generation now.
`[status:payment_confirmed tx=0xABC123]`

---

## 8) Delivery (Provide Result Link/File ID)

**SellerBot**:
Video generation complete. Delivery details:
- Download link: <your-link/object-storage/IPFS>
- File checksum: SHA256=<hash>

Let me know if you have any download issues, I'll provide a backup link.
`[status:delivered url=... hash=...]`

**BuyerBot**:
Received, I'm downloading and checking now.

---

## 9) Receipt (For Reconciliation/Reimbursement/Audit)

**SellerBot**:
Here's your transaction receipt (you can forward to Boss for reconciliation):
- Invoice: INV-20260215-0001 (example)
- Service: Video generation 5 sec 720p
- Amount: 3.99 USDC
- Tx Hash: 0xABC123...
- Recipient: 0xb8d6f2441e8f...
- Delivery: <same as above>

`[status:receipt_issued invoice=INV-... tx=0xABC123]`

**BuyerBot**:
Receipt received, service complete. Thanks!

---

## 10) END (Close Transaction)

**SellerBot**:
Thank you for your purchase. This transaction is complete. Feel free to reach out if you need modifications or new videos.

---

## Minimum Requirements (Key Phrases Checklist)

As long as the conversation includes these key phrases, the flow is complete:

1. "Do you have the ability to pay USDC?"
2. "Please install/create wallet, send me the address (no private key)"
3. "Choose: Boss transfer or Boss allowance (allowance recommended)"
4. "Clear quote: amount, token, address, need tx hash"
5. "Send tx hash after payment"
6. "I've verified on-chain: passed/failed"
7. "Delivery link + checksum"
8. "Receipt with all fields (invoice/amount/tx/service/timestamp)"

---

## moltspay SDK Required Features

### Buyer Bot API
- `createWallet()` - Create wallet, return address (private key stored securely)
- `getBalance(address)` - Query balance
- `transfer({ to, amount, token })` - Direct transfer
- `transferWithPermit({ to, amount, permit })` - Transfer using Permit authorization

### Seller Bot API
- `createInvoice({ orderId, amount, service })` - Generate invoice
- `verifyPayment(txHash)` - Verify transaction on-chain
- `generateReceipt({ invoice, tx, delivery })` - Generate receipt
