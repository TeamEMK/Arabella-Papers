// ════════════════════════════════════════════════════
// WHICH ORDERS ARE PRODUCTION'S WORK
//
// The SQL behind the production board, in one place, because more than the
// board asks the question now: the morning mail that chases unfinished
// stages has to chase exactly the orders the board shows, or it will name
// orders nobody can find.
//
// That is not a hypothetical. Written without these rules, the mail came out
// at 3,308 orders - the oldest sitting 929 days with every stage untouched,
// because the history imported from the sheet was never worked through the
// app. A mail that long is deleted unread on the first morning, and then the
// morning it matters it goes the same way.
//
// These were in routes/api/dashboards.js and are moved here unchanged; the
// router imports them from here now, so there is still one copy.
// ════════════════════════════════════════════════════

const LOCAL_ORDER_OFF_BOARDS = `LOWER(IFNULL(dealer_name, '')) <> 'local order'`;

const PRODUCTION_ARCHIVE_FROM = '2026-08-01';

const LAST_WORKED_ON = `GREATEST(
  COALESCE(actual_2, timestamp),
  COALESCE(guest_name_actual_time, '1000-01-01'),
  COALESCE(paper_cutting_actual_time, '1000-01-01'),
  COALESCE(dye_status_actual_time, '1000-01-01'),
  COALESCE(no_die_actual_time, '1000-01-01'),
  COALESCE(die_not_received_actual_time, '1000-01-01'),
  COALESCE(die_cutting_done_actual_time, '1000-01-01'),
  COALESCE(die_sent_actual_time, '1000-01-01'),
  COALESCE(block_status_actual_time, '1000-01-01'),
  COALESCE(no_block_actual_time, '1000-01-01'),
  COALESCE(block_not_received_actual_time, '1000-01-01'),
  COALESCE(block_printed_actual_time, '1000-01-01'),
  COALESCE(block_sent_actual_time, '1000-01-01'),
  COALESCE(printing_actual_time, '1000-01-01'),
  COALESCE(edges_actual_time, '1000-01-01'),
  COALESCE(no_laser_cutting_actual_time, '1000-01-01'),
  COALESCE(done_laser_cutting_actual_time, '1000-01-01'),
  COALESCE(pending_laser_cutting_actual_time, '1000-01-01'),
  COALESCE(no_output_actual_time, '1000-01-01'),
  COALESCE(output_done_actual_time, '1000-01-01'),
  COALESCE(output_pending_actual_time, '1000-01-01'),
  COALESCE(card_assembly_actual_time, '1000-01-01'),
  COALESCE(remark_actual_time, '1000-01-01'),
  COALESCE(reason_for_delay_actual_time, '1000-01-01')
)`;

const PRODUCTION_DATE = `DATE(${LAST_WORKED_ON})`;

const LEFT_FOR_DISPATCH = `((status_4 IS NOT NULL AND status_4 <> '') OR actual_4 IS NOT NULL)`;

const REACHED_PRODUCTION = `(
  TRIM(IFNULL(design_approval_status_from_client, '')) NOT IN ('Proofing Done', '')
  OR LOWER(IFNULL(paper_cutting, ''))  LIKE '%done%'
  OR LOWER(IFNULL(printing, ''))       LIKE '%done%'
  OR LOWER(IFNULL(card_assembly, ''))  LIKE '%done%'
  OR LOWER(IFNULL(dye_status, ''))     LIKE '%done%'
  OR LOWER(IFNULL(block_status, ''))   LIKE '%printed%'
)`;

const DEAD_ORDER = `(
  LOWER(IFNULL(design_approval_status_from_client, '')) LIKE '%rejected%'
  OR LOWER(IFNULL(design_approval_status_from_client, '')) LIKE '%cancel%'
  OR LOWER(IFNULL(design_status, '')) LIKE '%cancel%'
)`;

const PRODUCTION_QUEUE_WHERE = `
  is_deleted = 0
  AND NOT ${DEAD_ORDER}
  AND ${LOCAL_ORDER_OFF_BOARDS}
  AND ${REACHED_PRODUCTION}
`;

const ON_PRODUCTION_BOARD = (archive) => archive
  ? `IF(production_board IS NULL, ${PRODUCTION_DATE} < ?, production_board = 'old')`
  : `IF(production_board IS NULL, ${PRODUCTION_DATE} >= ?, production_board = 'current')`;

module.exports = {
  LOCAL_ORDER_OFF_BOARDS,
  PRODUCTION_ARCHIVE_FROM,
  LAST_WORKED_ON,
  PRODUCTION_DATE,
  LEFT_FOR_DISPATCH,
  REACHED_PRODUCTION,
  DEAD_ORDER,
  PRODUCTION_QUEUE_WHERE,
  ON_PRODUCTION_BOARD,
};
