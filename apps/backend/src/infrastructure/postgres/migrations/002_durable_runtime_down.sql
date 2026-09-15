DO $$
DECLARE
  contains_financial_records BOOLEAN := FALSE;
  contains_audit_records BOOLEAN := FALSE;
BEGIN
  IF to_regclass('public.ledger_operations') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM ledger_operations)'
      INTO contains_financial_records;
  END IF;
  IF to_regclass('public.audit_records') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM audit_records)'
      INTO contains_audit_records;
  END IF;
  IF contains_financial_records OR contains_audit_records THEN
    RAISE EXCEPTION
      'forward-only data policy: archive/reconcile ledger and audit records before schema down';
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS postings_must_balance ON postings;
DROP TRIGGER IF EXISTS postings_are_immutable ON postings;
DROP TABLE IF EXISTS audit_records CASCADE;
DROP TABLE IF EXISTS reservations CASCADE;
DROP TABLE IF EXISTS ledger_operations CASCADE;
DROP TABLE IF EXISTS dead_letter_events CASCADE;
DROP TABLE IF EXISTS processed_events CASCADE;
DROP TABLE IF EXISTS consumer_offsets CASCADE;
DROP TABLE IF EXISTS outbox_events CASCADE;
DROP TABLE IF EXISTS api_idempotency_records CASCADE;
DROP TABLE IF EXISTS command_status_history CASCADE;
DROP TABLE IF EXISTS command_journal CASCADE;
DROP FUNCTION IF EXISTS record_command_status_transition();
DROP FUNCTION IF EXISTS enforce_command_status_transition();
DROP FUNCTION IF EXISTS assert_balanced_ledger_operation();
DROP FUNCTION IF EXISTS prevent_immutable_row_change();
