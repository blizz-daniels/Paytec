const crypto = require("crypto");

function normalizeIdentifier(value) {
  return String(value || "").trim().toLowerCase();
}

function parseResourceId(rawValue) {
  const parsed = Number.parseInt(String(rawValue || "").trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseDateToken(value) {
  const token = String(value || "").trim();
  if (!token) {
    return "";
  }
  const isoCandidate = token.replace(/\./g, "-").replace(/\//g, "-");
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(isoCandidate)) {
    const [y, m, d] = isoCandidate.split("-").map((entry) => Number.parseInt(entry, 10));
    if (y > 1900 && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
  }
  if (/^\d{1,2}-\d{1,2}-\d{4}$/.test(isoCandidate)) {
    const [a, b, y] = isoCandidate.split("-").map((entry) => Number.parseInt(entry, 10));
    if (y > 1900) {
      const asDayFirst = `${String(y).padStart(4, "0")}-${String(b).padStart(2, "0")}-${String(a).padStart(2, "0")}`;
      const parsed = new Date(asDayFirst);
      if (!Number.isNaN(parsed.getTime())) {
        return asDayFirst;
      }
    }
  }
  const parsed = new Date(token);
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }
  return parsed.toISOString().slice(0, 10);
}

function createPaymentNormalizationHelpers(options = {}) {
  const paymentReferencePrefix = String(options.paymentReferencePrefix || "PAYTEC");
  const paymentReferenceTenantId = String(options.paymentReferenceTenantId || "default-school");
  const paystackSource = String(options.paystackSource || "paystack");

  function isValidIsoLikeDate(value) {
    if (!value) {
      return false;
    }
    const date = new Date(String(value));
    return !Number.isNaN(date.getTime());
  }

  function parseMoneyValue(value) {
    const amount = Number.parseFloat(String(value));
    if (!Number.isFinite(amount)) {
      return null;
    }
    return amount;
  }

  function parseAvailabilityDays(value) {
    const raw = String(value ?? "").trim();
    if (!raw) {
      return null;
    }
    const days = Number.parseInt(raw, 10);
    if (!Number.isFinite(days) || days <= 0 || days > 3650) {
      return null;
    }
    return days;
  }

  function computeAvailableUntil(availabilityDays) {
    if (!Number.isFinite(availabilityDays) || availabilityDays <= 0) {
      return null;
    }
    const now = new Date();
    const end = new Date(now.getTime() + availabilityDays * 24 * 60 * 60 * 1000);
    return end.toISOString();
  }

  function parseCurrency(value) {
    const text = String(value || "NGN").trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(text)) {
      return null;
    }
    return text;
  }

  function sanitizeTransactionRef(value) {
    return String(value || "").trim().slice(0, 120);
  }

  function sanitizeReceiptStatus(value) {
    const status = String(value || "").trim().toLowerCase();
    const allowed = new Set(["submitted", "under_review", "approved", "rejected"]);
    return allowed.has(status) ? status : "";
  }

  function sanitizeAssignmentFilter(value) {
    const normalized = String(value || "").trim().toLowerCase();
    const allowed = new Set(["all", "mine", "unassigned"]);
    return allowed.has(normalized) ? normalized : "all";
  }

  function sanitizeBulkReceiptAction(value) {
    const normalized = String(value || "").trim().toLowerCase();
    const allowed = new Set(["assign", "under_review", "approve", "reject", "note", "bulk_verify"]);
    return allowed.has(normalized) ? normalized : "";
  }

  function sanitizeReconciliationStatus(value) {
    const normalized = String(value || "").trim().toLowerCase();
    const allowed = new Set([
      "all",
      "approved",
      "needs_review",
      "unmatched",
      "duplicate",
      "rejected",
      "needs_student_confirmation",
    ]);
    return allowed.has(normalized) ? normalized : "all";
  }

  function sanitizeReconciliationReason(value) {
    const normalized = String(value || "").trim().toLowerCase();
    const allowed = new Set([
      "all",
      "exact_reference",
      "amount_match",
      "payer_hint_match",
      "item_hint_match",
      "student_hint_match",
      "date_proximity_match",
      "ambiguous_candidate",
      "no_candidate",
      "duplicate_transaction",
      "manual_approved",
      "manual_rejected",
      "needs_student_confirmation",
    ]);
    return allowed.has(normalized) ? normalized : "all";
  }

  function sanitizeReconciliationBulkAction(value) {
    const normalized = String(value || "").trim().toLowerCase();
    const allowed = new Set(["approve", "reject", "request_student_confirmation", "merge_duplicates"]);
    return allowed.has(normalized) ? normalized : "";
  }

  function normalizeReasonCodes(raw) {
    if (!Array.isArray(raw)) {
      return [];
    }
    return Array.from(
      new Set(
        raw
          .map((entry) => String(entry || "").trim().toLowerCase())
          .filter(Boolean)
          .slice(0, 20)
      )
    );
  }

  function parseJsonObject(value, fallback = {}) {
    try {
      const parsed = value ? JSON.parse(value) : fallback;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return fallback;
      }
      return parsed;
    } catch (_err) {
      return fallback;
    }
  }

  function parseJsonArray(value, fallback = []) {
    try {
      const parsed = value ? JSON.parse(value) : fallback;
      if (!Array.isArray(parsed)) {
        return fallback;
      }
      return parsed;
    } catch (_err) {
      return fallback;
    }
  }

  function toSafeConfidence(value, fallback = 0) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return fallback;
    }
    if (parsed < 0) return 0;
    if (parsed > 1) return 1;
    return parsed;
  }

  function buildDeterministicPaymentReference(paymentItemId, studentUsername, attempt = 0) {
    const itemToken = Number.parseInt(paymentItemId, 10);
    const studentToken = normalizeIdentifier(studentUsername).replace(/[^a-z0-9]/g, "") || "student";
    const base = `${String(paymentReferencePrefix || "PAYTEC")
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 10)}-${String(itemToken || 0).padStart(4, "0")}`;
    const digest = crypto
      .createHash("sha1")
      .update(`${paymentReferenceTenantId}|${itemToken}:${studentToken}|${Number.parseInt(attempt, 10) || 0}`)
      .digest("hex")
      .slice(0, 14)
      .toUpperCase();
    const shortStudent = studentToken.slice(0, 8).toUpperCase() || "STUDENT";
    if (!attempt) {
      return `${base}-${shortStudent}-${digest}`.slice(0, 120);
    }
    const suffix = digest.slice(0, Math.min(4 + attempt, 8));
    return `${base}-${shortStudent}-${digest}-${suffix}`.slice(0, 120);
  }

  function buildDeterministicReferenceCandidates(paymentItemId, studentUsername, maxAttempts = 8) {
    const candidates = [];
    const safeAttempts = Math.max(1, Math.min(12, Number.parseInt(maxAttempts, 10) || 1));
    for (let i = 0; i < safeAttempts; i += 1) {
      candidates.push(buildDeterministicPaymentReference(paymentItemId, studentUsername, i));
    }
    return candidates;
  }

  function parseReceiptIdList(rawValues, limit = 50) {
    if (!Array.isArray(rawValues)) {
      return [];
    }
    const ids = [];
    const seen = new Set();
    for (const rawValue of rawValues) {
      const id = parseResourceId(rawValue);
      if (!id || seen.has(id)) {
        continue;
      }
      ids.push(id);
      seen.add(id);
      if (ids.length >= limit) {
        break;
      }
    }
    return ids;
  }

  function normalizeWhitespace(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function normalizeStatementName(value) {
    return normalizeWhitespace(value).toLowerCase();
  }

  function normalizeReference(value) {
    return String(value || "").trim().toLowerCase().slice(0, 120);
  }

  function toDateOnly(value) {
    const date = new Date(String(value || ""));
    if (Number.isNaN(date.getTime())) {
      return "";
    }
    return date.toISOString().slice(0, 10);
  }

  function almostSameAmount(left, right, tolerance = 0.01) {
    const l = Number(left);
    const r = Number(right);
    if (!Number.isFinite(l) || !Number.isFinite(r)) {
      return false;
    }
    return Math.abs(l - r) <= tolerance;
  }

  function buildTransactionChecksum(input = {}) {
    const source = String(input.source || "statement_upload")
      .trim()
      .toLowerCase()
      .slice(0, 40);
    const txnRef = normalizeReference(input.txn_ref || input.reference || "");
    const amount = Number(input.amount);
    const amountToken = Number.isFinite(amount) ? amount.toFixed(2) : "";
    const dateToken = parseDateToken(input.date || input.paid_at || input.paidAt || input.normalized_paid_date || "");
    const payerToken = normalizeStatementName(input.payer_name || input.payerName || input.name || "");
    if (!amountToken || !dateToken) {
      return "";
    }
    const key = `${txnRef}|${amountToken}|${dateToken}|${payerToken}|${source}`;
    return crypto.createHash("sha1").update(key).digest("hex");
  }

  function toKoboFromAmount(amount) {
    const parsed = Number(amount);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return null;
    }
    return Math.round(parsed * 100);
  }

  function toAmountFromKobo(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return null;
    }
    return parsed / 100;
  }

  function buildPaystackGatewayReference(obligationId, studentUsername) {
    const idToken = String(Number.parseInt(obligationId, 10) || 0).padStart(6, "0");
    const studentToken = normalizeIdentifier(studentUsername)
      .replace(/[^a-z0-9]/g, "")
      .toUpperCase()
      .slice(0, 8) || "STUDENT";
    const timestampToken = Date.now().toString(36).toUpperCase();
    const randomToken = crypto.randomBytes(4).toString("hex").toUpperCase();
    return `PSTK-${idToken}-${studentToken}-${timestampToken}-${randomToken}`.slice(0, 120);
  }

  function parsePaystackMetadata(rawMetadata) {
    if (!rawMetadata) {
      return {};
    }
    if (typeof rawMetadata === "string") {
      return parseJsonObject(rawMetadata, {});
    }
    if (typeof rawMetadata === "object" && !Array.isArray(rawMetadata)) {
      return rawMetadata;
    }
    return {};
  }

  function extractPaystackPayerName(transaction, metadata) {
    const customer =
      transaction && transaction.customer && typeof transaction.customer === "object" ? transaction.customer : {};
    const first = String(customer.first_name || "").trim();
    const last = String(customer.last_name || "").trim();
    const full = [first, last].filter(Boolean).join(" ").trim();
    return (
      full ||
      String(customer.name || "").trim() ||
      String(metadata.student_username || metadata.studentUsername || metadata.student || "").trim() ||
      String(customer.email || "").trim() ||
      "unknown payer"
    );
  }

  function buildPaystackSourceEventId(payload, transaction) {
    const event = String(payload?.event || "charge.success").trim().toLowerCase();
    const baseToken =
      payload?.id ||
      payload?.event_id ||
      transaction?.id ||
      transaction?.reference ||
      crypto.createHash("sha1").update(JSON.stringify(payload || {})).digest("hex").slice(0, 40);
    return `paystack-${event}-${String(baseToken).trim().slice(0, 120)}`.slice(0, 160);
  }

  function normalizePaystackTransactionForIngestion(payload, options = {}) {
    const transaction = payload && payload.data && typeof payload.data === "object" ? payload.data : {};
    const metadata = parsePaystackMetadata(transaction.metadata);
    const gatewayReference = sanitizeTransactionRef(transaction.reference || transaction.gateway_response || "");
    const amount = toAmountFromKobo(transaction.amount);
    const paidAt =
      String(transaction.paid_at || transaction.created_at || transaction.transaction_date || payload?.paid_at || "").trim() ||
      new Date().toISOString();
    const txnReference = sanitizeTransactionRef(metadata.payment_reference || metadata.paymentReference || gatewayReference);
    const sourceEventId = String(options.sourceEventId || buildPaystackSourceEventId(payload, transaction))
      .trim()
      .slice(0, 160);
    const studentHint = normalizeIdentifier(
      metadata.student_username || metadata.studentUsername || metadata.student || metadata.student_id || ""
    );
    const paymentItemHint = parseResourceId(metadata.payment_item_id || metadata.paymentItemId || "");
    const payerName = extractPaystackPayerName(transaction, metadata);

    if (!amount || !paidAt || !sourceEventId || !gatewayReference) {
      return null;
    }

    const checksum = buildTransactionChecksum({
      source: paystackSource,
      txn_ref: gatewayReference,
      amount,
      date: paidAt,
      payer_name: payerName,
    });

    return {
      payload: {
        source: paystackSource,
        source_event_id: sourceEventId,
        txn_ref: txnReference,
        amount,
        date: paidAt,
        payer_name: payerName,
        payment_item_id: paymentItemHint || null,
        student_username: studentHint || null,
        checksum,
        raw_payload: payload,
      },
      gatewayReference,
      metadata,
      transaction,
      sourceEventId,
      amount,
    };
  }

  function isValidPaystackSignature(rawBody, headerSignature, secret) {
    const signature = String(headerSignature || "").trim().toLowerCase();
    const secretKey = String(secret || "").trim();
    if (!signature || !secretKey || !rawBody || !rawBody.length) {
      return false;
    }
    const expected = crypto.createHmac("sha512", secretKey).update(rawBody).digest("hex");
    const expectedBuffer = Buffer.from(expected, "utf8");
    const providedBuffer = Buffer.from(signature, "utf8");
    if (expectedBuffer.length !== providedBuffer.length) {
      return false;
    }
    return crypto.timingSafeEqual(expectedBuffer, providedBuffer);
  }

  return {
    isValidIsoLikeDate,
    parseMoneyValue,
    parseAvailabilityDays,
    computeAvailableUntil,
    parseCurrency,
    sanitizeTransactionRef,
    sanitizeReceiptStatus,
    sanitizeAssignmentFilter,
    sanitizeBulkReceiptAction,
    sanitizeReconciliationStatus,
    sanitizeReconciliationReason,
    sanitizeReconciliationBulkAction,
    normalizeReasonCodes,
    parseJsonObject,
    parseJsonArray,
    toSafeConfidence,
    buildDeterministicPaymentReference,
    buildDeterministicReferenceCandidates,
    parseReceiptIdList,
    normalizeWhitespace,
    normalizeStatementName,
    normalizeReference,
    toDateOnly,
    almostSameAmount,
    buildTransactionChecksum,
    toKoboFromAmount,
    toAmountFromKobo,
    buildPaystackGatewayReference,
    parsePaystackMetadata,
    extractPaystackPayerName,
    buildPaystackSourceEventId,
    normalizePaystackTransactionForIngestion,
    isValidPaystackSignature,
  };
}

module.exports = {
  createPaymentNormalizationHelpers,
};
