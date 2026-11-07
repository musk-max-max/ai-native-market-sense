-- Migration: Add source_internal_only to serving_quote_realtime (SEC-012 / F1 residual)
-- Date: 2026-11-06
-- Author: A1 (data-ingest)
-- Reason: H4 SEC-012 requirement — akshare source must be marked internal-only,
--         C-end display blocked until H3/H4 written ruling.
--
-- Semantics:
--   source_internal_only = true  → row is INTERNAL ONLY, must NOT be shown to C-end users
--   source_internal_only = false → row PASSES SEC-012 source filtering (NOT the same as C-end approved)
--     ⚠️ C-end visibility requires BOTH gates:
--       ① source_internal_only = false (SEC-012 source filter, this field)
--       ② c_end_display toggle enabled (B5 display gate)
--     Two gates are independent; neither replaces the other.
--
-- Fail-closed policy: unknown/unrecognized sources default to true (internal-only).
-- Only explicitly whitelisted sources (currently 'tushare') are marked false.
--
-- DO NOT remove this marker before H3/H4 written ruling (H4 SEC-012 §12.4).

-- The view definition is idempotent (CREATE OR REPLACE VIEW).
-- This migration documents the semantic contract for audit trail.

COMMENT ON COLUMN serving.serving_quote_realtime.source_internal_only IS
    'SEC-012/F1 residual: true = internal-only (C-end display blocked); false = passes SEC-012 source filter (NOT C-end approved). '
    'C-end visibility requires BOTH: source_internal_only=false AND c_end_display toggle (B5). Two gates are independent. '
    'Fail-closed: unknown sources default true. Only tushare=false currently. '
    'DO NOT remove before H3/H4 written ruling (SEC-012 §12.4).';
