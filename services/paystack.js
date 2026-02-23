const DEFAULT_PAYSTACK_BASE_URL = "https://api.paystack.co";
const DEFAULT_TIMEOUT_MS = 12000;

function toSafeTimeout(value, fallback = DEFAULT_TIMEOUT_MS) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed) || parsed < 1000 || parsed > 60000) {
    return fallback;
  }
  return parsed;
}

function createPaystackClient(options = {}) {
  const secretKey = String(options.secretKey || process.env.PAYSTACK_SECRET_KEY || "").trim();
  const baseUrl = String(options.baseUrl || process.env.PAYSTACK_API_BASE_URL || DEFAULT_PAYSTACK_BASE_URL)
    .trim()
    .replace(/\/$/, "");
  const timeoutMs = toSafeTimeout(options.timeoutMs || process.env.PAYSTACK_TIMEOUT_MS);

  async function request(path, requestOptions = {}) {
    if (!secretKey) {
      const err = new Error("Paystack secret key is not configured.");
      err.code = "paystack_missing_secret";
      err.status = 500;
      throw err;
    }

    const method = String(requestOptions.method || "GET")
      .trim()
      .toUpperCase();
    const endpointPath = String(path || "").trim();
    if (!endpointPath.startsWith("/")) {
      const err = new Error("Paystack endpoint path must start with '/'.");
      err.code = "paystack_invalid_path";
      err.status = 500;
      throw err;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), toSafeTimeout(requestOptions.timeoutMs, timeoutMs));
    const headers = {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/json",
      ...(requestOptions.headers || {}),
    };

    try {
      const response = await fetch(`${baseUrl}${endpointPath}`, {
        method,
        headers,
        body: requestOptions.body ? JSON.stringify(requestOptions.body) : undefined,
        signal: controller.signal,
      });

      const rawText = await response.text();
      let payload = null;
      if (rawText) {
        try {
          payload = JSON.parse(rawText);
        } catch (_err) {
          payload = null;
        }
      }

      if (!response.ok) {
        const err = new Error(
          (payload && payload.message) || `Paystack API request failed (${response.status}).`
        );
        err.code = "paystack_api_error";
        err.status = response.status;
        err.response = payload || rawText || null;
        throw err;
      }

      if (payload && payload.status === false) {
        const err = new Error(payload.message || "Paystack request returned an unsuccessful response.");
        err.code = "paystack_api_error";
        err.status = response.status || 502;
        err.response = payload;
        throw err;
      }

      return payload;
    } catch (err) {
      if (err && err.name === "AbortError") {
        const timeoutError = new Error("Paystack request timed out.");
        timeoutError.code = "paystack_timeout";
        timeoutError.status = 504;
        throw timeoutError;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async function initializeTransaction(input = {}) {
    return request("/transaction/initialize", {
      method: "POST",
      body: {
        email: input.email,
        amount: input.amount,
        reference: input.reference,
        callback_url: input.callback_url,
        metadata: input.metadata || {},
        currency: input.currency || "NGN",
      },
    });
  }

  async function verifyTransaction(reference) {
    const safeReference = String(reference || "").trim();
    if (!safeReference) {
      const err = new Error("Paystack reference is required.");
      err.code = "paystack_reference_required";
      err.status = 400;
      throw err;
    }
    return request(`/transaction/verify/${encodeURIComponent(safeReference)}`, {
      method: "GET",
    });
  }

  return {
    hasSecretKey: !!secretKey,
    initializeTransaction,
    verifyTransaction,
    request,
  };
}

module.exports = {
  createPaystackClient,
};