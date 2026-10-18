PRAGMA page_size=4096;
PRAGMA journal_mode=DELETE;
PRAGMA application_id=1347572819;
PRAGMA user_version=1;
CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE source_blobs(sha256 TEXT PRIMARY KEY,raw_len INTEGER NOT NULL,body BLOB NOT NULL);
CREATE TABLE sources(namespace TEXT,path TEXT,sha256 TEXT NOT NULL,
  PRIMARY KEY(namespace,path), FOREIGN KEY(sha256) REFERENCES source_blobs(sha256));
CREATE TABLE entities(dataset TEXT,bucket TEXT,key TEXT,ordinal INTEGER,payload TEXT,aux TEXT,
  PRIMARY KEY(dataset,bucket,key));
CREATE INDEX entity_order ON entities(dataset,bucket,ordinal);
CREATE INDEX entity_aux ON entities(dataset,bucket,aux,ordinal);
CREATE TABLE names(dataset TEXT,name TEXT,key TEXT,ordinal INTEGER,PRIMARY KEY(dataset,name));
CREATE TABLE searches(scope TEXT,ordinal INTEGER,text TEXT,payload TEXT,PRIMARY KEY(scope,ordinal));
CREATE TABLE search_blocks(scope TEXT,block INTEGER,first_ordinal INTEGER,last_ordinal INTEGER,payload BLOB,
  PRIMARY KEY(scope,block));
CREATE TABLE story_events(id TEXT PRIMARY KEY);
CREATE TABLE story_chapters(ordinal INTEGER PRIMARY KEY,event TEXT,story_key TEXT,code TEXT,name TEXT,line_count INTEGER);
CREATE INDEX story_event_order ON story_chapters(event,ordinal);
CREATE TABLE story_lines(id INTEGER PRIMARY KEY,chapter INTEGER,line INTEGER,kind TEXT,role TEXT,role_fold TEXT,text TEXT,text_fold TEXT);
CREATE UNIQUE INDEX story_line_order ON story_lines(chapter,line);
CREATE INDEX story_role ON story_lines(role_fold,chapter,line);
CREATE INDEX story_kind ON story_lines(kind,chapter,line);
CREATE TABLE story_blocks(chapter INTEGER,block INTEGER,first_line INTEGER,last_line INTEGER,payload BLOB,
  PRIMARY KEY(chapter,block));
CREATE TABLE story_speakers(event TEXT,role TEXT,count INTEGER,PRIMARY KEY(event,role));
CREATE TABLE enemy_appearances(enemy TEXT,ordinal INTEGER,stage TEXT,count INTEGER,PRIMARY KEY(enemy,ordinal));
