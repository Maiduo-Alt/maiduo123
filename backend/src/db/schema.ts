/** 数据库结构定义（幂等，可重复执行）。 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS roles (
  id            SERIAL PRIMARY KEY,
  code          VARCHAR(32) NOT NULL UNIQUE,
  name          VARCHAR(64) NOT NULL,
  permission_json JSONB NOT NULL DEFAULT '[]'::jsonb
);

CREATE TABLE IF NOT EXISTS groups (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(64) NOT NULL,
  manager_id    INTEGER,
  status        SMALLINT NOT NULL DEFAULT 1,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS accounts (
  id            SERIAL PRIMARY KEY,
  username      VARCHAR(32) NOT NULL UNIQUE,
  password_hash VARCHAR(128) NOT NULL,
  display_name  VARCHAR(32) NOT NULL,
  employee_no   VARCHAR(32),
  mobile        VARCHAR(20),
  role_code     VARCHAR(32) NOT NULL DEFAULT 'agent',
  group_id      INTEGER,
  status        SMALLINT NOT NULL DEFAULT 1,
  preference    JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_login_at TIMESTAMPTZ,
  login_fail_count   INTEGER NOT NULL DEFAULT 0,
  locked_until       TIMESTAMPTZ,
  password_changed_at TIMESTAMPTZ,
  must_change_password BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_params (
  id            SERIAL PRIMARY KEY,
  value         JSONB NOT NULL,
  version       INTEGER NOT NULL DEFAULT 1,
  updated_by    INTEGER,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS categories (
  id            SERIAL PRIMARY KEY,
  type          VARCHAR(16) NOT NULL,
  name          VARCHAR(64) NOT NULL,
  parent_id     INTEGER,
  sort          INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS products (
  id            SERIAL PRIMARY KEY,
  product_no    VARCHAR(32) NOT NULL UNIQUE,
  title         VARCHAR(160) NOT NULL,
  cover_url     VARCHAR(512),
  detail_images JSONB NOT NULL DEFAULT '[]'::jsonb,
  price         NUMERIC(10,2) NOT NULL DEFAULT 0,
  origin_price  NUMERIC(10,2),
  stock         INTEGER NOT NULL DEFAULT 0,
  skus          JSONB NOT NULL DEFAULT '[]'::jsonb,
  attributes    JSONB NOT NULL DEFAULT '[]'::jsonb,
  services      JSONB NOT NULL DEFAULT '[]'::jsonb,
  scenes        JSONB NOT NULL DEFAULT '[]'::jsonb,
  category      VARCHAR(64),
  status        SMALLINT NOT NULL DEFAULT 1,
  deleted_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS buyer_bg (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(80) NOT NULL,
  description   VARCHAR(300) NOT NULL DEFAULT '',
  category      VARCHAR(64) NOT NULL DEFAULT '通用',
  created_by    INTEGER,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS buyer_qa (
  id            SERIAL PRIMARY KEY,
  template_name VARCHAR(80) NOT NULL,
  question      VARCHAR(1000) NOT NULL,
  question_list JSONB NOT NULL DEFAULT '[]'::jsonb,
  image_url     VARCHAR(512),
  accepted_answer VARCHAR(1500),
  key_points    JSONB NOT NULL DEFAULT '[]'::jsonb,
  stage         VARCHAR(16) NOT NULL DEFAULT 'presale',
  category      VARCHAR(64) NOT NULL DEFAULT '通用',
  created_by    INTEGER,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS styles (
  id            SERIAL PRIMARY KEY,
  code          VARCHAR(32) NOT NULL UNIQUE,
  name          VARCHAR(64) NOT NULL,
  description   VARCHAR(300) NOT NULL DEFAULT '',
  tone_sample   VARCHAR(300) NOT NULL DEFAULT '',
  emotion_base  INTEGER NOT NULL DEFAULT 20,
  ratio         NUMERIC(5,2),
  is_emotional  BOOLEAN NOT NULL DEFAULT false,
  is_builtin    BOOLEAN NOT NULL DEFAULT false,
  sort          INTEGER NOT NULL DEFAULT 0,
  status        SMALLINT NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS scripts (
  id            SERIAL PRIMARY KEY,
  script_no     VARCHAR(32) NOT NULL UNIQUE,
  name          VARCHAR(160) NOT NULL,
  category      VARCHAR(64) NOT NULL DEFAULT '培训',
  stage         VARCHAR(16) NOT NULL DEFAULT 'presale',
  bg_id         INTEGER NOT NULL,
  qa_id         INTEGER NOT NULL,
  style_id      INTEGER NOT NULL,
  style_manual  BOOLEAN NOT NULL DEFAULT false,
  product_ids   JSONB NOT NULL DEFAULT '[]'::jsonb,
  question_seq  JSONB NOT NULL DEFAULT '[]'::jsonb,
  status        SMALLINT NOT NULL DEFAULT 1,
  practiced_count INTEGER NOT NULL DEFAULT 0,
  avg_score     NUMERIC(5,2),
  last_practiced_at TIMESTAMPTZ,
  created_by    INTEGER,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS attempts (
  id            SERIAL PRIMARY KEY,
  attempt_no    VARCHAR(32) NOT NULL UNIQUE,
  account_id    INTEGER NOT NULL,
  level         VARCHAR(4) NOT NULL,
  source        VARCHAR(16) NOT NULL DEFAULT 'free',
  task_id       INTEGER,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ,
  total_score   NUMERIC(5,1),
  conclusion    VARCHAR(8),
  status        VARCHAR(16) NOT NULL DEFAULT 'running',
  param_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS sessions (
  id            SERIAL PRIMARY KEY,
  attempt_id    INTEGER NOT NULL,
  script_id     INTEGER NOT NULL,
  product_id    INTEGER,
  buyer_name    VARCHAR(32) NOT NULL,
  style_code    VARCHAR(32) NOT NULL DEFAULT 'friendly',
  state         VARCHAR(16) NOT NULL DEFAULT 'wait',
  current_seq   INTEGER NOT NULL DEFAULT 0,
  total_questions INTEGER NOT NULL DEFAULT 0,
  questions     JSONB NOT NULL DEFAULT '[]'::jsonb,
  products      JSONB NOT NULL DEFAULT '[]'::jsonb,
  order_no      VARCHAR(32),
  order_amount  NUMERIC(10,2),
  order_status  VARCHAR(32),
  -- 订单卡片要展示的完整快照（下单/付款/承诺发货/物流/签收等状态相关字段太多，
  -- 不适合每个都开一列）；单号与金额仍冗余在上面两列，便于查询统计
  order_payload JSONB,
  last_buyer_at TIMESTAMPTZ,
  last_agent_at TIMESTAMPTZ,
  first_reply_at TIMESTAMPTZ,
  join_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ,
  finished_reason VARCHAR(16),
  max_response_sec INTEGER,
  avg_response_sec INTEGER,
  timeout_count INTEGER NOT NULL DEFAULT 0,
  emotion_value INTEGER NOT NULL DEFAULT 20,
  unresolved_streak INTEGER NOT NULL DEFAULT 0,
  transferred_seqs JSONB NOT NULL DEFAULT '[]'::jsonb,
  score         NUMERIC(5,1)
);

CREATE TABLE IF NOT EXISTS messages (
  id            SERIAL PRIMARY KEY,
  session_id    INTEGER NOT NULL,
  sender        VARCHAR(8) NOT NULL,
  content       TEXT NOT NULL,
  content_type  SMALLINT NOT NULL DEFAULT 1,
  seq           INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  response_sec  INTEGER,
  is_timeout    BOOLEAN NOT NULL DEFAULT false,
  rule_result   JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- 业务动作（客户 2026-10-03）：订单卡片上的催付 / 改价 / 去发货 等平台侧操作，
-- 在训练环境里记为一次动作——同时给买家发一条标准话术，复盘时能看到点过哪些动作。
CREATE TABLE IF NOT EXISTS session_actions (
  id            SERIAL PRIMARY KEY,
  session_id    INTEGER NOT NULL,
  attempt_id    INTEGER NOT NULL,
  action_code   VARCHAR(32) NOT NULL,
  action_name   VARCHAR(32) NOT NULL,
  order_stage   VARCHAR(16),
  content       TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS scores (
  id            SERIAL PRIMARY KEY,
  session_id    INTEGER NOT NULL UNIQUE,
  attempt_id    INTEGER NOT NULL,
  response_score NUMERIC(5,1) NOT NULL,
  solving_score NUMERIC(5,1) NOT NULL,
  wording_score NUMERIC(5,1) NOT NULL,
  emotion_score NUMERIC(5,1) NOT NULL,
  total_score   NUMERIC(5,1) NOT NULL,
  deductions    JSONB NOT NULL DEFAULT '[]'::jsonb,
  metrics       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS annotations (
  id            SERIAL PRIMARY KEY,
  attempt_id    INTEGER NOT NULL,
  session_id    INTEGER,
  message_id    INTEGER,
  author_id     INTEGER NOT NULL,
  content       TEXT NOT NULL,
  reply_content TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tasks (
  id            SERIAL PRIMARY KEY,
  task_no       VARCHAR(32) NOT NULL UNIQUE,
  name          VARCHAR(80) NOT NULL,
  levels        JSONB NOT NULL DEFAULT '[]'::jsonb,
  scope_type    VARCHAR(16) NOT NULL DEFAULT 'all',
  scope_value   JSONB NOT NULL DEFAULT '{}'::jsonb,
  start_at      TIMESTAMPTZ NOT NULL,
  deadline      TIMESTAMPTZ NOT NULL,
  target_count  INTEGER NOT NULL DEFAULT 1,
  status        VARCHAR(16) NOT NULL DEFAULT 'running',
  created_by    INTEGER,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS task_targets (
  id            SERIAL PRIMARY KEY,
  task_id       INTEGER NOT NULL,
  metric        VARCHAR(32) NOT NULL,
  operator      VARCHAR(8) NOT NULL,
  threshold     NUMERIC(10,2) NOT NULL
);

CREATE TABLE IF NOT EXISTS task_assignees (
  id            SERIAL PRIMARY KEY,
  task_id       INTEGER NOT NULL,
  account_id    INTEGER NOT NULL,
  done_count    INTEGER NOT NULL DEFAULT 0,
  status        VARCHAR(16) NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS cases (
  id            SERIAL PRIMARY KEY,
  title         VARCHAR(160) NOT NULL,
  source_type   VARCHAR(16) NOT NULL DEFAULT 'paste',
  shop          VARCHAR(64),
  stage         VARCHAR(16) NOT NULL DEFAULT 'presale',
  tags          JSONB NOT NULL DEFAULT '[]'::jsonb,
  message_count INTEGER NOT NULL DEFAULT 0,
  duration_sec  INTEGER NOT NULL DEFAULT 0,
  status        VARCHAR(16) NOT NULL DEFAULT 'ready',
  created_by    INTEGER,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS case_messages (
  id            SERIAL PRIMARY KEY,
  case_id       INTEGER NOT NULL,
  seq           INTEGER NOT NULL,
  sender        VARCHAR(8) NOT NULL,
  content       TEXT NOT NULL,
  is_excellent  BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS phrases (
  id            SERIAL PRIMARY KEY,
  category      VARCHAR(64) NOT NULL DEFAULT '通用',
  title         VARCHAR(64) NOT NULL,
  content       VARCHAR(500) NOT NULL,
  variables     JSONB NOT NULL DEFAULT '[]'::jsonb,
  used_count    INTEGER NOT NULL DEFAULT 0,
  status        SMALLINT NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS unlock_progress (
  id            SERIAL PRIMARY KEY,
  account_id    INTEGER NOT NULL,
  level         VARCHAR(4) NOT NULL,
  streak        INTEGER NOT NULL DEFAULT 0,
  unlocked      BOOLEAN NOT NULL DEFAULT false,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS action_logs (
  id            SERIAL PRIMARY KEY,
  account_id    INTEGER,
  action        VARCHAR(64) NOT NULL,
  detail        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 批量生成剧本的异步任务（方案 5.7：超过异步阈值时改为后台任务，支持进度与取消）
CREATE TABLE IF NOT EXISTS script_gen_tasks (
  id            SERIAL PRIMARY KEY,
  status        VARCHAR(16) NOT NULL DEFAULT 'running',
  total         INTEGER NOT NULL DEFAULT 0,
  created_count INTEGER NOT NULL DEFAULT 0,
  failed_count  INTEGER NOT NULL DEFAULT 0,
  message       VARCHAR(300),
  created_by    INTEGER,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);
CREATE INDEX IF NOT EXISTS idx_sessions_attempt ON sessions(attempt_id);
CREATE INDEX IF NOT EXISTS idx_attempts_account ON attempts(account_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_scripts_qa ON scripts(qa_id);
CREATE INDEX IF NOT EXISTS idx_scripts_status ON scripts(status);

-- 2026-10-09 商品属性（插件采集详情页参数表）：已有库幂等补列
ALTER TABLE products ADD COLUMN IF NOT EXISTS attributes JSONB NOT NULL DEFAULT '[]'::jsonb;
`;
