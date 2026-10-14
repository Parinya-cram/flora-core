-- Form Studio template library (MySQL). Mirrors 0083-formdev-template.sql.
CREATE TABLE IF NOT EXISTS formdev_template (
  template_id varchar(64) NOT NULL PRIMARY KEY,
  title varchar(400) NOT NULL,
  description text NOT NULL,
  origin varchar(16) NOT NULL,
  status varchar(16) NOT NULL,
  definition longtext NOT NULL,
  report longtext NULL,
  sources longtext NOT NULL,
  version int NOT NULL,
  created_at bigint NOT NULL,
  created_by varchar(191) NULL,
  updated_at bigint NOT NULL,
  updated_by varchar(191) NULL,
  KEY formdev_template_updated (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
