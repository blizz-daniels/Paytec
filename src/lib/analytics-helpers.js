function createAnalyticsHelpers(options = {}) {
  const get = options.get;
  const all = options.all;
  const parseResourceId = options.parseResourceId;
  const isAdminSession = options.isAdminSession;
  const normalizeIdentifier = options.normalizeIdentifier;
  const isValidIsoLikeDate = options.isValidIsoLikeDate;
  const escapeCsvCell = options.escapeCsvCell;

  if (typeof get !== "function" || typeof all !== "function") {
    throw new Error("createAnalyticsHelpers requires get and all database functions.");
  }
  if (typeof parseResourceId !== "function") {
    throw new Error("createAnalyticsHelpers requires parseResourceId.");
  }
  if (typeof isAdminSession !== "function" || typeof normalizeIdentifier !== "function") {
    throw new Error("createAnalyticsHelpers requires isAdminSession and normalizeIdentifier.");
  }
  if (typeof isValidIsoLikeDate !== "function") {
    throw new Error("createAnalyticsHelpers requires isValidIsoLikeDate.");
  }
  if (typeof escapeCsvCell !== "function") {
    throw new Error("createAnalyticsHelpers requires escapeCsvCell.");
  }

  const ANALYTICS_TOP_ITEM_SORT_TO_ORDER_BY = Object.freeze({
    collected_desc: "collected_total DESC, transaction_count DESC, pi.id ASC",
    collected_asc: "collected_total ASC, transaction_count DESC, pi.id ASC",
    transactions_desc: "transaction_count DESC, collected_total DESC, pi.id ASC",
    transactions_asc: "transaction_count ASC, collected_total DESC, pi.id ASC",
    outstanding_desc: "outstanding_amount DESC, collected_total DESC, pi.id ASC",
    outstanding_asc: "outstanding_amount ASC, collected_total DESC, pi.id ASC",
    title_asc: "pi.title COLLATE NOCASE ASC, pi.id ASC",
  });

  function asFiniteNumber(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function toAnalyticsAmount(value) {
    return Number(asFiniteNumber(value, 0).toFixed(2));
  }

  function toAnalyticsPercent(value) {
    return Number(asFiniteNumber(value, 0).toFixed(2));
  }

  function getAnalyticsDefaultDateRange(days = 30) {
    const safeDays = Number.isFinite(days) && days > 0 ? Math.floor(days) : 30;
    const toDate = new Date();
    toDate.setHours(0, 0, 0, 0);
    const fromDate = new Date(toDate.getTime() - (safeDays - 1) * 24 * 60 * 60 * 1000);
    return {
      from: fromDate.toISOString().slice(0, 10),
      to: toDate.toISOString().slice(0, 10),
    };
  }

  function isStrictIsoDate(value) {
    const text = String(value || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
      return false;
    }
    if (!isValidIsoLikeDate(text)) {
      return false;
    }
    const parsed = new Date(`${text}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text;
  }

  function parseAnalyticsGranularity(rawValue, options = {}) {
    const value = String(rawValue || "").trim().toLowerCase();
    const required = options.required === true;
    if (!value) {
      if (required) {
        throw { status: 400, error: "Query parameter 'granularity' is required (day, week, month)." };
      }
      return "day";
    }
    if (!["day", "week", "month"].includes(value)) {
      throw { status: 400, error: "Query parameter 'granularity' must be one of: day, week, month." };
    }
    return value;
  }

  function parseAnalyticsLimit(rawValue, defaultLimit = 10, maxLimit = 50) {
    const text = String(rawValue ?? "").trim();
    if (!text) {
      return defaultLimit;
    }
    const parsed = Number.parseInt(text, 10);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > maxLimit) {
      throw {
        status: 400,
        error: `Query parameter 'limit' must be an integer between 1 and ${maxLimit}.`,
      };
    }
    return parsed;
  }

  function parseAnalyticsTopItemsSort(rawValue) {
    const value = String(rawValue || "").trim().toLowerCase();
    if (!value) {
      return "collected_desc";
    }
    if (!ANALYTICS_TOP_ITEM_SORT_TO_ORDER_BY[value]) {
      throw {
        status: 400,
        error:
          "Query parameter 'sort' must be one of: collected_desc, collected_asc, transactions_desc, transactions_asc, outstanding_desc, outstanding_asc, title_asc.",
      };
    }
    return value;
  }

  async function parseAnalyticsFilters(req, queryInput, options = {}) {
    const query = queryInput || {};
    const defaultRange = getAnalyticsDefaultDateRange();
    const fromRaw = String(query.from || "").trim();
    const toRaw = String(query.to || "").trim();
    const from = fromRaw || defaultRange.from;
    const to = toRaw || defaultRange.to;
    if (!isStrictIsoDate(from)) {
      throw { status: 400, error: "Query parameter 'from' must be a valid date in YYYY-MM-DD format." };
    }
    if (!isStrictIsoDate(to)) {
      throw { status: 400, error: "Query parameter 'to' must be a valid date in YYYY-MM-DD format." };
    }
    if (from > to) {
      throw { status: 400, error: "Query parameter 'from' must be less than or equal to 'to'." };
    }

    const paymentItemRaw = String(query.paymentItemId || "").trim();
    const paymentItemId = paymentItemRaw ? parseResourceId(paymentItemRaw) : null;
    if (paymentItemRaw && !paymentItemId) {
      throw { status: 400, error: "Query parameter 'paymentItemId' must be a positive integer." };
    }
    if (paymentItemId) {
      const row = await get("SELECT id, created_by FROM payment_items WHERE id = ? LIMIT 1", [paymentItemId]);
      if (!row) {
        throw { status: 400, error: "Query parameter 'paymentItemId' is invalid." };
      }
      if (!isAdminSession(req) && normalizeIdentifier(row.created_by) !== normalizeIdentifier(req.session.user.username)) {
        throw { status: 400, error: "Query parameter 'paymentItemId' is invalid." };
      }
    }

    const filters = {
      from,
      to,
      paymentItemId,
      granularity: parseAnalyticsGranularity(query.granularity, {
        required: options.requireGranularity === true,
      }),
    };

    if (options.includeLimit) {
      filters.limit = parseAnalyticsLimit(
        query.limit,
        Number.isFinite(options.defaultLimit) ? Number(options.defaultLimit) : 10,
        Number.isFinite(options.maxLimit) ? Number(options.maxLimit) : 50
      );
    }
    if (options.includeSort) {
      filters.sort = parseAnalyticsTopItemsSort(query.sort);
    }
    return filters;
  }

  function buildAnalyticsScopedWhereClause(req, filters, options = {}) {
    const conditions = [];
    const params = [];
    const includeDateRange = options.includeDateRange !== false;
    const includePaymentItemFilter = options.includePaymentItemFilter !== false;
    const dateExpression = String(options.dateExpression || "COALESCE(pt.paid_at, pt.created_at)");
    const paymentItemExpression = String(options.paymentItemExpression || "pi.id");
    const paymentItemOwnerExpression = String(options.paymentItemOwnerExpression || "pi.created_by");

    if (includeDateRange) {
      conditions.push(`DATE(${dateExpression}) >= DATE(?)`);
      params.push(filters.from);
      conditions.push(`DATE(${dateExpression}) <= DATE(?)`);
      params.push(filters.to);
    }
    if (includePaymentItemFilter && filters.paymentItemId) {
      conditions.push(`${paymentItemExpression} = ?`);
      params.push(filters.paymentItemId);
    }
    if (!isAdminSession(req)) {
      conditions.push(`${paymentItemOwnerExpression} = ?`);
      params.push(req.session.user.username);
    }
    if (Array.isArray(options.extraConditions)) {
      options.extraConditions
        .map((entry) => String(entry || "").trim())
        .filter(Boolean)
        .forEach((entry) => conditions.push(entry));
    }
    if (Array.isArray(options.extraParams) && options.extraParams.length) {
      params.push(...options.extraParams);
    }

    return {
      conditions,
      params,
      whereClause: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "",
    };
  }

  function getAnalyticsBucketExpression(granularity, dateExpression) {
    const normalized = String(granularity || "day").trim().toLowerCase();
    const safeDateExpression = `DATE(${String(dateExpression || "CURRENT_TIMESTAMP")})`;
    if (normalized === "week") {
      return `strftime('%Y-W%W', ${safeDateExpression})`;
    }
    if (normalized === "month") {
      return `strftime('%Y-%m', ${safeDateExpression})`;
    }
    return `strftime('%Y-%m-%d', ${safeDateExpression})`;
  }

  async function getAnalyticsOverviewPayload(req, filters) {
    const transactionScoped = buildAnalyticsScopedWhereClause(req, filters, {
      dateExpression: "COALESCE(pt.paid_at, pt.created_at)",
      paymentItemExpression: "COALESCE(po.payment_item_id, pt.payment_item_hint_id)",
      paymentItemOwnerExpression: "pi.created_by",
    });
    const obligationScoped = buildAnalyticsScopedWhereClause(req, filters, {
      dateExpression: "COALESCE(po.due_date, po.created_at)",
      paymentItemExpression: "po.payment_item_id",
      paymentItemOwnerExpression: "pi.created_by",
    });
    const exceptionScoped = buildAnalyticsScopedWhereClause(req, filters, {
      dateExpression: "COALESCE(pt.paid_at, pt.created_at)",
      paymentItemExpression: "COALESCE(po.payment_item_id, pt.payment_item_hint_id)",
      paymentItemOwnerExpression: "pi.created_by",
      extraConditions: ["re.status = 'open'"],
    });
    const receiptScoped = buildAnalyticsScopedWhereClause(req, filters, {
      dateExpression: "COALESCE(pr.reviewed_at, pr.submitted_at)",
      paymentItemExpression: "pr.payment_item_id",
      paymentItemOwnerExpression: "pi.created_by",
    });
    const receiptConditions = ["pr.status = 'approved'"].concat(receiptScoped.conditions);
    const receiptWhere = receiptConditions.length ? `WHERE ${receiptConditions.join(" AND ")}` : "";

    const [collectedRow, obligationRow, exceptionRow, receiptRow] = await Promise.all([
      get(
        `
          SELECT
            COALESCE(SUM(CASE WHEN pt.status = 'approved' THEN pt.amount ELSE 0 END), 0) AS total_collected,
            COALESCE(SUM(CASE WHEN pt.status = 'approved' THEN 1 ELSE 0 END), 0) AS approved_count,
            COALESCE(
              SUM(
                CASE
                  WHEN pt.status = 'approved' AND COALESCE(pt.reasons_json, '[]') NOT LIKE '%manual_approved%' THEN 1
                  ELSE 0
                END
              ),
              0
            ) AS auto_approved_count
          FROM payment_transactions pt
          LEFT JOIN payment_obligations po ON po.id = pt.matched_obligation_id
          LEFT JOIN payment_items pi ON pi.id = COALESCE(po.payment_item_id, pt.payment_item_hint_id)
          ${transactionScoped.whereClause}
        `,
        transactionScoped.params
      ),
      get(
        `
          SELECT
            COALESCE(SUM(po.expected_amount), 0) AS expected_total,
            COALESCE(
              SUM(
                CASE
                  WHEN po.expected_amount - COALESCE(po.amount_paid_total, 0) > 0.01 THEN po.expected_amount - COALESCE(po.amount_paid_total, 0)
                  ELSE 0
                END
              ),
              0
            ) AS outstanding_total
          FROM payment_obligations po
          JOIN payment_items pi ON pi.id = po.payment_item_id
          ${obligationScoped.whereClause}
        `,
        obligationScoped.params
      ),
      get(
        `
          SELECT COUNT(*) AS open_exceptions
          FROM reconciliation_exceptions re
          JOIN payment_matches pm ON pm.id = re.match_id
          JOIN payment_transactions pt ON pt.id = pm.transaction_id
          LEFT JOIN payment_obligations po ON po.id = COALESCE(pm.obligation_id, pt.matched_obligation_id)
          LEFT JOIN payment_items pi ON pi.id = COALESCE(po.payment_item_id, pt.payment_item_hint_id)
          ${exceptionScoped.whereClause}
        `,
        exceptionScoped.params
      ),
      get(
        `
          SELECT
            COUNT(*) AS approved_receipt_total,
            COALESCE(
              SUM(
                CASE
                  WHEN COALESCE(ard.receipt_sent, 0) = 1 AND COALESCE(ard.receipt_file_path, '') != '' THEN 1
                  ELSE 0
                END
              ),
              0
            ) AS approved_receipt_success
          FROM payment_receipts pr
          JOIN payment_items pi ON pi.id = pr.payment_item_id
          LEFT JOIN approved_receipt_dispatches ard ON ard.payment_receipt_id = pr.id
          ${receiptWhere}
        `,
        receiptScoped.params
      ),
    ]);

    const totalCollected = toAnalyticsAmount(collectedRow?.total_collected);
    const expectedAmount = toAnalyticsAmount(obligationRow?.expected_total);
    const outstandingAmount = toAnalyticsAmount(obligationRow?.outstanding_total);
    const approvedCount = asFiniteNumber(collectedRow?.approved_count, 0);
    const autoApprovedCount = asFiniteNumber(collectedRow?.auto_approved_count, 0);
    const openExceptionsCount = Math.max(0, Math.floor(asFiniteNumber(exceptionRow?.open_exceptions, 0)));
    const approvedReceiptTotal = asFiniteNumber(receiptRow?.approved_receipt_total, 0);
    const approvedReceiptSuccess = asFiniteNumber(receiptRow?.approved_receipt_success, 0);

    const collectionRate = expectedAmount > 0 ? toAnalyticsPercent((totalCollected / expectedAmount) * 100) : 0;
    const autoApprovalRate = approvedCount > 0 ? toAnalyticsPercent((autoApprovedCount / approvedCount) * 100) : 0;
    const approvedReceiptGenerationSuccessRate =
      approvedReceiptTotal > 0 ? toAnalyticsPercent((approvedReceiptSuccess / approvedReceiptTotal) * 100) : 0;

    return {
      filters: {
        from: filters.from,
        to: filters.to,
        paymentItemId: filters.paymentItemId || null,
        granularity: filters.granularity,
      },
      kpis: {
        totalCollected,
        expectedAmount,
        outstandingAmount,
        collectionRate,
        openExceptionsCount,
        autoApprovalRate,
        approvedReceiptGenerationSuccessRate,
      },
    };
  }

  async function getAnalyticsRevenueSeriesPayload(req, filters) {
    const bucketExpression = getAnalyticsBucketExpression(filters.granularity, "COALESCE(pt.paid_at, pt.created_at)");
    const scoped = buildAnalyticsScopedWhereClause(req, filters, {
      dateExpression: "COALESCE(pt.paid_at, pt.created_at)",
      paymentItemExpression: "COALESCE(po.payment_item_id, pt.payment_item_hint_id)",
      paymentItemOwnerExpression: "pi.created_by",
      extraConditions: ["pt.status = 'approved'"],
    });
    const rows = await all(
      `
        SELECT
          ${bucketExpression} AS bucket,
          COALESCE(SUM(pt.amount), 0) AS collected_amount,
          COUNT(*) AS transaction_count
        FROM payment_transactions pt
        LEFT JOIN payment_obligations po ON po.id = pt.matched_obligation_id
        LEFT JOIN payment_items pi ON pi.id = COALESCE(po.payment_item_id, pt.payment_item_hint_id)
        ${scoped.whereClause}
        GROUP BY bucket
        ORDER BY bucket ASC
      `,
      scoped.params
    );
    const series = rows.map((row) => ({
      bucket: String(row.bucket || ""),
      collectedAmount: toAnalyticsAmount(row.collected_amount),
      transactionCount: Math.max(0, Math.floor(asFiniteNumber(row.transaction_count, 0))),
    }));
    const totalCollected = toAnalyticsAmount(series.reduce((acc, row) => acc + asFiniteNumber(row.collectedAmount, 0), 0));
    return {
      filters: {
        from: filters.from,
        to: filters.to,
        paymentItemId: filters.paymentItemId || null,
        granularity: filters.granularity,
      },
      series,
      totals: {
        totalCollected,
      },
    };
  }

  async function getAnalyticsStatusBreakdownPayload(req, filters) {
    const scoped = buildAnalyticsScopedWhereClause(req, filters, {
      dateExpression: "COALESCE(pt.paid_at, pt.created_at)",
      paymentItemExpression: "COALESCE(po.payment_item_id, pt.payment_item_hint_id)",
      paymentItemOwnerExpression: "pi.created_by",
    });
    const rows = await all(
      `
        SELECT
          COALESCE(NULLIF(TRIM(pt.status), ''), 'unknown') AS status,
          COUNT(*) AS count
        FROM payment_transactions pt
        LEFT JOIN payment_obligations po ON po.id = pt.matched_obligation_id
        LEFT JOIN payment_items pi ON pi.id = COALESCE(po.payment_item_id, pt.payment_item_hint_id)
        ${scoped.whereClause}
        GROUP BY status
        ORDER BY count DESC, status ASC
      `,
      scoped.params
    );
    const breakdown = rows.map((row) => ({
      status: String(row.status || "unknown"),
      count: Math.max(0, Math.floor(asFiniteNumber(row.count, 0))),
    }));
    return {
      filters: {
        from: filters.from,
        to: filters.to,
        paymentItemId: filters.paymentItemId || null,
        granularity: filters.granularity,
      },
      total: breakdown.reduce((acc, row) => acc + row.count, 0),
      breakdown,
    };
  }

  async function getAnalyticsReconciliationFunnelPayload(req, filters) {
    const scoped = buildAnalyticsScopedWhereClause(req, filters, {
      dateExpression: "COALESCE(pt.paid_at, pt.created_at)",
      paymentItemExpression: "COALESCE(po.payment_item_id, pt.payment_item_hint_id)",
      paymentItemOwnerExpression: "pi.created_by",
    });
    const row = await get(
      `
        SELECT
          COUNT(*) AS ingested,
          COALESCE(SUM(CASE WHEN pt.status = 'approved' THEN 1 ELSE 0 END), 0) AS approved,
          COALESCE(SUM(CASE WHEN pt.status = 'needs_review' THEN 1 ELSE 0 END), 0) AS needs_review,
          COALESCE(SUM(CASE WHEN pt.status = 'unmatched' THEN 1 ELSE 0 END), 0) AS unmatched,
          COALESCE(SUM(CASE WHEN pt.status = 'duplicate' THEN 1 ELSE 0 END), 0) AS duplicate,
          COALESCE(SUM(CASE WHEN pt.status = 'rejected' THEN 1 ELSE 0 END), 0) AS rejected,
          COALESCE(SUM(CASE WHEN pt.status = 'needs_student_confirmation' THEN 1 ELSE 0 END), 0) AS needs_student_confirmation
        FROM payment_transactions pt
        LEFT JOIN payment_obligations po ON po.id = pt.matched_obligation_id
        LEFT JOIN payment_items pi ON pi.id = COALESCE(po.payment_item_id, pt.payment_item_hint_id)
        ${scoped.whereClause}
      `,
      scoped.params
    );
    const stages = [
      ["ingested", row?.ingested],
      ["approved", row?.approved],
      ["needs_review", row?.needs_review],
      ["unmatched", row?.unmatched],
      ["duplicate", row?.duplicate],
      ["rejected", row?.rejected],
      ["needs_student_confirmation", row?.needs_student_confirmation],
    ].map(([stage, count]) => ({
      stage,
      count: Math.max(0, Math.floor(asFiniteNumber(count, 0))),
    }));
    return {
      filters: {
        from: filters.from,
        to: filters.to,
        paymentItemId: filters.paymentItemId || null,
        granularity: filters.granularity,
      },
      stages,
    };
  }

  async function getAnalyticsTopItemsPayload(req, filters) {
    const outerScoped = buildAnalyticsScopedWhereClause(req, filters, {
      includeDateRange: false,
      paymentItemExpression: "pi.id",
      paymentItemOwnerExpression: "pi.created_by",
    });
    const orderBy =
      ANALYTICS_TOP_ITEM_SORT_TO_ORDER_BY[filters.sort] || ANALYTICS_TOP_ITEM_SORT_TO_ORDER_BY.collected_desc;
    const rows = await all(
      `
        WITH approved_range AS (
          SELECT
            COALESCE(po.payment_item_id, pt.payment_item_hint_id) AS payment_item_id,
            COALESCE(SUM(CASE WHEN pt.status = 'approved' THEN pt.amount ELSE 0 END), 0) AS collected_total,
            COALESCE(SUM(CASE WHEN pt.status = 'approved' THEN 1 ELSE 0 END), 0) AS approved_count,
            COUNT(*) AS transaction_count
          FROM payment_transactions pt
          LEFT JOIN payment_obligations po ON po.id = pt.matched_obligation_id
          WHERE DATE(COALESCE(pt.paid_at, pt.created_at)) >= DATE(?)
            AND DATE(COALESCE(pt.paid_at, pt.created_at)) <= DATE(?)
          GROUP BY COALESCE(po.payment_item_id, pt.payment_item_hint_id)
        ),
        obligation_totals AS (
          SELECT
            po.payment_item_id,
            COALESCE(SUM(po.expected_amount), 0) AS expected_total,
            COALESCE(
              SUM(
                CASE
                  WHEN po.expected_amount - COALESCE(po.amount_paid_total, 0) > 0.01 THEN po.expected_amount - COALESCE(po.amount_paid_total, 0)
                  ELSE 0
                END
              ),
              0
            ) AS outstanding_amount
          FROM payment_obligations po
          GROUP BY po.payment_item_id
        )
        SELECT
          pi.id AS payment_item_id,
          pi.title,
          pi.currency,
          COALESCE(approved_range.collected_total, 0) AS collected_total,
          COALESCE(approved_range.approved_count, 0) AS approved_count,
          COALESCE(approved_range.transaction_count, 0) AS transaction_count,
          COALESCE(obligation_totals.expected_total, 0) AS expected_total,
          COALESCE(obligation_totals.outstanding_amount, 0) AS outstanding_amount
        FROM payment_items pi
        LEFT JOIN approved_range ON approved_range.payment_item_id = pi.id
        LEFT JOIN obligation_totals ON obligation_totals.payment_item_id = pi.id
        ${outerScoped.whereClause}
        ORDER BY ${orderBy}
        LIMIT ${Math.max(1, Math.floor(asFiniteNumber(filters.limit, 10)))}
      `,
      [filters.from, filters.to].concat(outerScoped.params)
    );
    const items = rows.map((row) => ({
      paymentItemId: parseResourceId(row.payment_item_id),
      title: String(row.title || ""),
      currency: String(row.currency || "NGN"),
      collectedTotal: toAnalyticsAmount(row.collected_total),
      approvedCount: Math.max(0, Math.floor(asFiniteNumber(row.approved_count, 0))),
      transactionCount: Math.max(0, Math.floor(asFiniteNumber(row.transaction_count, 0))),
      expectedAmount: toAnalyticsAmount(row.expected_total),
      outstandingAmount: toAnalyticsAmount(row.outstanding_amount),
    }));
    return {
      filters: {
        from: filters.from,
        to: filters.to,
        paymentItemId: filters.paymentItemId || null,
        granularity: filters.granularity,
      },
      sort: filters.sort,
      limit: filters.limit,
      items,
    };
  }

  async function getAnalyticsPaystackFunnelPayload(req, filters) {
    const scoped = buildAnalyticsScopedWhereClause(req, filters, {
      dateExpression: "COALESCE(ps.updated_at, ps.created_at)",
      paymentItemExpression: "po.payment_item_id",
      paymentItemOwnerExpression: "pi.created_by",
    });
    const row = await get(
      `
        SELECT
          COALESCE(SUM(CASE WHEN LOWER(COALESCE(ps.status, '')) = 'initiated' THEN 1 ELSE 0 END), 0) AS initiated,
          COALESCE(
            SUM(CASE WHEN LOWER(COALESCE(ps.status, '')) IN ('pending_webhook', 'pending', 'processing') THEN 1 ELSE 0 END),
            0
          ) AS pending_webhook,
          COALESCE(SUM(CASE WHEN LOWER(COALESCE(ps.status, '')) = 'approved' THEN 1 ELSE 0 END), 0) AS approved,
          COALESCE(SUM(CASE WHEN LOWER(COALESCE(ps.status, '')) = 'under_review' THEN 1 ELSE 0 END), 0) AS under_review,
          COALESCE(SUM(CASE WHEN LOWER(COALESCE(ps.status, '')) = 'failed' THEN 1 ELSE 0 END), 0) AS failed
        FROM paystack_sessions ps
        JOIN payment_obligations po ON po.id = ps.obligation_id
        JOIN payment_items pi ON pi.id = po.payment_item_id
        ${scoped.whereClause}
      `,
      scoped.params
    );
    const stages = [
      ["initiated", row?.initiated],
      ["pending_webhook", row?.pending_webhook],
      ["approved", row?.approved],
      ["under_review", row?.under_review],
      ["failed", row?.failed],
    ].map(([stage, count]) => ({
      stage,
      count: Math.max(0, Math.floor(asFiniteNumber(count, 0))),
    }));
    return {
      filters: {
        from: filters.from,
        to: filters.to,
        paymentItemId: filters.paymentItemId || null,
        granularity: filters.granularity,
      },
      stages,
    };
  }

  async function getAnalyticsAgingPayload(req, filters) {
    const scoped = buildAnalyticsScopedWhereClause(req, filters, {
      dateExpression: "COALESCE(po.due_date, po.created_at)",
      paymentItemExpression: "po.payment_item_id",
      paymentItemOwnerExpression: "pi.created_by",
    });
    const rows = await all(
      `
        SELECT
          CASE
            WHEN po.expected_amount - COALESCE(po.amount_paid_total, 0) <= 0.01 THEN 'settled'
            WHEN po.due_date IS NULL OR TRIM(po.due_date) = '' THEN 'current'
            WHEN CAST(julianday(DATE(?)) - julianday(DATE(po.due_date)) AS INTEGER) <= 0 THEN 'current'
            WHEN CAST(julianday(DATE(?)) - julianday(DATE(po.due_date)) AS INTEGER) BETWEEN 1 AND 7 THEN 'overdue_1_7'
            WHEN CAST(julianday(DATE(?)) - julianday(DATE(po.due_date)) AS INTEGER) BETWEEN 8 AND 30 THEN 'overdue_8_30'
            ELSE 'overdue_31_plus'
          END AS bucket,
          COUNT(*) AS obligations_count,
          COALESCE(
            SUM(
              CASE
                WHEN po.expected_amount - COALESCE(po.amount_paid_total, 0) > 0.01 THEN po.expected_amount - COALESCE(po.amount_paid_total, 0)
                ELSE 0
              END
            ),
            0
          ) AS outstanding_amount
        FROM payment_obligations po
        JOIN payment_items pi ON pi.id = po.payment_item_id
        ${scoped.whereClause}
        GROUP BY bucket
      `,
      [filters.to, filters.to, filters.to].concat(scoped.params)
    );
    const bucketMap = new Map(
      rows.map((row) => [
        String(row.bucket || ""),
        {
          obligationsCount: Math.max(0, Math.floor(asFiniteNumber(row.obligations_count, 0))),
          outstandingAmount: toAnalyticsAmount(row.outstanding_amount),
        },
      ])
    );
    const buckets = [
      ["current", "Current"],
      ["overdue_1_7", "1-7 overdue"],
      ["overdue_8_30", "8-30 overdue"],
      ["overdue_31_plus", "31+ overdue"],
    ].map(([bucketKey, label]) => {
      const entry = bucketMap.get(bucketKey) || { obligationsCount: 0, outstandingAmount: 0 };
      return {
        bucket: bucketKey,
        label,
        obligationsCount: entry.obligationsCount,
        outstandingAmount: entry.outstandingAmount,
      };
    });
    return {
      filters: {
        from: filters.from,
        to: filters.to,
        paymentItemId: filters.paymentItemId || null,
        granularity: filters.granularity,
      },
      buckets,
      totals: {
        outstandingAmount: toAnalyticsAmount(
          buckets.reduce((acc, bucket) => acc + asFiniteNumber(bucket.outstandingAmount, 0), 0)
        ),
      },
    };
  }

  function appendAnalyticsCsvSection(lines, title, headers, rows) {
    lines.push(title);
    lines.push(headers.map((header) => escapeCsvCell(header)).join(","));
    if (!rows.length) {
      lines.push(escapeCsvCell("No data for selected range"));
      lines.push("");
      return;
    }
    rows.forEach((row) => {
      lines.push(row.map((cell) => escapeCsvCell(cell)).join(","));
    });
    lines.push("");
  }

  function buildAnalyticsExportCsv(filters, payload) {
    const lines = [];
    lines.push("Paytec Analytics Export");
    lines.push(`Generated At,${escapeCsvCell(new Date().toISOString())}`);
    lines.push(`From,${escapeCsvCell(filters.from)}`);
    lines.push(`To,${escapeCsvCell(filters.to)}`);
    lines.push(`Granularity,${escapeCsvCell(filters.granularity)}`);
    lines.push(`Payment Item ID,${escapeCsvCell(filters.paymentItemId || "all")}`);
    lines.push("");

    appendAnalyticsCsvSection(lines, "Overview", ["metric", "value"], [
      ["total_collected", payload.overview.kpis.totalCollected],
      ["expected_amount", payload.overview.kpis.expectedAmount],
      ["outstanding_amount", payload.overview.kpis.outstandingAmount],
      ["collection_rate_percent", payload.overview.kpis.collectionRate],
      ["open_exceptions_count", payload.overview.kpis.openExceptionsCount],
      ["auto_approval_rate_percent", payload.overview.kpis.autoApprovalRate],
      [
        "approved_receipt_generation_success_rate_percent",
        payload.overview.kpis.approvedReceiptGenerationSuccessRate,
      ],
    ]);

    appendAnalyticsCsvSection(
      lines,
      "Revenue Series",
      ["bucket", "collected_amount", "transaction_count"],
      payload.revenue.series.map((row) => [row.bucket, row.collectedAmount, row.transactionCount])
    );

    appendAnalyticsCsvSection(
      lines,
      "Transaction Status Breakdown",
      ["status", "count"],
      payload.statusBreakdown.breakdown.map((row) => [row.status, row.count])
    );

    appendAnalyticsCsvSection(
      lines,
      "Reconciliation Funnel",
      ["stage", "count"],
      payload.reconciliationFunnel.stages.map((row) => [row.stage, row.count])
    );

    appendAnalyticsCsvSection(
      lines,
      "Top Payment Items",
      [
        "payment_item_id",
        "title",
        "currency",
        "collected_total",
        "approved_count",
        "transaction_count",
        "expected_amount",
        "outstanding_amount",
      ],
      payload.topItems.items.map((row) => [
        row.paymentItemId,
        row.title,
        row.currency,
        row.collectedTotal,
        row.approvedCount,
        row.transactionCount,
        row.expectedAmount,
        row.outstandingAmount,
      ])
    );

    appendAnalyticsCsvSection(
      lines,
      "Aging Buckets",
      ["bucket", "label", "obligations_count", "outstanding_amount"],
      payload.aging.buckets.map((row) => [row.bucket, row.label, row.obligationsCount, row.outstandingAmount])
    );

    appendAnalyticsCsvSection(
      lines,
      "Paystack Funnel",
      ["stage", "count"],
      payload.paystackFunnel.stages.map((row) => [row.stage, row.count])
    );

    return lines.join("\n");
  }

  function isAnalyticsValidationError(err) {
    return Number(err?.status || 0) === 400;
  }

  return {
    parseAnalyticsFilters,
    getAnalyticsOverviewPayload,
    getAnalyticsRevenueSeriesPayload,
    getAnalyticsStatusBreakdownPayload,
    getAnalyticsReconciliationFunnelPayload,
    getAnalyticsTopItemsPayload,
    getAnalyticsPaystackFunnelPayload,
    getAnalyticsAgingPayload,
    buildAnalyticsExportCsv,
    isAnalyticsValidationError,
  };
}

module.exports = {
  createAnalyticsHelpers,
};
