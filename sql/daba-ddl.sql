CREATE SCHEMA IF NOT EXISTS shoval;

SET search_path TO shoval;

CREATE TABLE shoval.record_statuses (
    id character varying(20) NOT NULL,
    CONSTRAINT recordstatuses_pkey PRIMARY KEY (id)
);

CREATE TABLE shoval.material_types (
    code character varying(20) NOT NULL,
    CONSTRAINT materialtypes_pkey PRIMARY KEY (code)
);

CREATE TABLE shoval.units_of_measure (
    id character varying(20) NOT NULL,
    CONSTRAINT pk_units_of_measure PRIMARY KEY (id)
);

CREATE TABLE shoval.supply_centers (
    id integer NOT NULL,
    description character varying(40),
    CONSTRAINT supplycenters_pkey PRIMARY KEY (id)
);

CREATE TABLE shoval.unit_levels (
    id integer NOT NULL,
    description character varying(15),
    CONSTRAINT unitlevels_pkey PRIMARY KEY (id)
);

CREATE TABLE shoval.unit_types (
    id integer NOT NULL,
    description character varying(255),
    CONSTRAINT unittypes_pkey PRIMARY KEY (id)
);

CREATE TABLE shoval.main_categories (
    id character varying(3) NOT NULL,
    description character varying(40),
    CONSTRAINT maincategories_pkey PRIMARY KEY (id)
);

CREATE TABLE shoval.sub_categories (
    id character varying(3) NOT NULL,
    description character varying(40),
    CONSTRAINT subcategories_pkey PRIMARY KEY (id)
);

CREATE TABLE shoval.second_categories (
    id character varying(3) NOT NULL,
    description character varying(40),
    CONSTRAINT secondcategories_pkey PRIMARY KEY (id)
);

CREATE TABLE shoval.unit_relation_types (
    id character varying(10) NOT NULL,
    description character varying(40),
    sap_id character varying(40),
    CONSTRAINT unitrelationtypes_pkey PRIMARY KEY (id)
);

CREATE TABLE shoval.unit_status_types (
    id integer NOT NULL,
    description character varying(20),
    CONSTRAINT unitstatuses_pkey PRIMARY KEY (id)
);

CREATE TABLE shoval.units_ids (
    id integer NOT NULL,
    CONSTRAINT unitids_pkey PRIMARY KEY (id)
);

CREATE SEQUENCE shoval.reporttypes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE shoval.reporttypes_id_seq OWNED BY shoval.report_types.id;

CREATE TABLE shoval.report_types (
    id integer DEFAULT nextval('shoval.reporttypes_id_seq'::regclass) NOT NULL,
    description character varying(255),
    CONSTRAINT reporttypes_pkey PRIMARY KEY (id)
);

CREATE TABLE shoval.stock_types (
    id integer NOT NULL,
    description character varying(25),
    CONSTRAINT stocktypes_pkey PRIMARY KEY (id)
);

CREATE TABLE shoval.material_standard_group_types (
    id character varying(20) NOT NULL,
    CONSTRAINT material_standard_group_types_pkey PRIMARY KEY (id)
);

CREATE SEQUENCE shoval.tag_group_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

CREATE TABLE shoval.tag_group (
    id integer DEFAULT nextval('shoval.tag_group_id_seq'::regclass) NOT NULL,
    description character varying(30) NOT NULL,
    CONSTRAINT tag_group_description_key UNIQUE (description),
    CONSTRAINT tag_group_pkey PRIMARY KEY (id)
);

CREATE TABLE shoval.supply_sections (
    id integer NOT NULL,
    description character varying(40),
    center_id integer NOT NULL,
    CONSTRAINT supplysections_pkey PRIMARY KEY (id, center_id),
    CONSTRAINT supplysections_center_id_fkey FOREIGN KEY (center_id) REFERENCES shoval.supply_centers(id) ON DELETE CASCADE
);

CREATE TABLE shoval.tsav_irgun_codes (
    id character varying(10) NOT NULL,
    description character varying(50),
    record_status_id character varying(20) NOT NULL,
    CONSTRAINT tsavirguncodes_pkey PRIMARY KEY (id),
    CONSTRAINT tsavirguncodes_record_status_fkey FOREIGN KEY (record_status_id) REFERENCES shoval.record_statuses(id) ON DELETE CASCADE
);

CREATE TABLE shoval.users (
    id character varying(20) NOT NULL,
    unit_id integer NOT NULL,
    name character varying(50),
    CONSTRAINT unit_users_pkey PRIMARY KEY (id),
    CONSTRAINT unitusers_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES shoval.units_ids(id) ON DELETE CASCADE
);

CREATE TABLE shoval.units (
    unit_id integer NOT NULL,
    object_type character varying(2) NOT NULL,
    description character varying(255),
    level_id integer NOT NULL,
    unit_type_id integer,
    tsav_irgun_code character varying(10),
    start_date date NOT NULL,
    end_date date NOT NULL,
    CONSTRAINT units_pkey PRIMARY KEY (unit_id, start_date, object_type),
    CONSTRAINT fk_unit_details__tsav_irgun_code_id FOREIGN KEY (tsav_irgun_code) REFERENCES shoval.tsav_irgun_codes(id) ON DELETE SET NULL,
    CONSTRAINT units_id_fkey FOREIGN KEY (unit_id) REFERENCES shoval.units_ids(id) ON DELETE CASCADE,
    CONSTRAINT units_level_id_fkey FOREIGN KEY (level_id) REFERENCES shoval.unit_levels(id) ON DELETE CASCADE,
    CONSTRAINT units_unit_type_id_fkey FOREIGN KEY (unit_type_id) REFERENCES shoval.unit_types(id) ON DELETE CASCADE
);

CREATE TABLE shoval.standard_groups (
    id character varying(9) NOT NULL,
    name character varying(40) NOT NULL,
    group_type character varying(20),
    status character varying(20) NOT NULL,
    CONSTRAINT standard_groups_pkey PRIMARY KEY (id),
    CONSTRAINT standard_groups_group_type_fkey FOREIGN KEY (group_type) REFERENCES shoval.material_standard_group_types(id),
    CONSTRAINT standard_groups_status_fkey FOREIGN KEY (status) REFERENCES shoval.record_statuses(id)
);

CREATE SEQUENCE shoval.tag_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

CREATE TABLE shoval.standard_tags (
    id integer DEFAULT nextval('shoval.tag_id_seq'::regclass) NOT NULL,
    tag_group_id integer,
    unit_level integer NOT NULL,
    tag character varying(30) NOT NULL,
    CONSTRAINT standard_tags_pkey PRIMARY KEY (id),
    CONSTRAINT standard_tags_tag_key UNIQUE (tag_group_id, tag, unit_level),
    CONSTRAINT standard_tags_tag_group_id_fkey FOREIGN KEY (tag_group_id) REFERENCES shoval.tag_group(id) ON DELETE CASCADE,
    CONSTRAINT standard_tags_unit_level_fkey FOREIGN KEY (unit_level) REFERENCES shoval.unit_levels(id)
);

CREATE TABLE shoval.standard_attributes (
    id SERIAL NOT NULL,
    managing_unit integer,
    item_group_id character varying(9),
    tool_group_id character varying(9),
    CONSTRAINT standard_attributes_pkey PRIMARY KEY (id),
    CONSTRAINT standard_attributes_item_group_id_fkey FOREIGN KEY (item_group_id) REFERENCES shoval.standard_groups(id),
    CONSTRAINT standard_attributes_managing_unit__fkey FOREIGN KEY (managing_unit) REFERENCES shoval.units_ids(id),
    CONSTRAINT standard_attributes_tool_group_id_fkey FOREIGN KEY (tool_group_id) REFERENCES shoval.standard_groups(id)
);

CREATE TABLE shoval.standard_values (
    standard_id integer NOT NULL,
    tag_id integer NOT NULL,
    quantity numeric,
    note text,
    CONSTRAINT standard_values_pkey PRIMARY KEY (standard_id, tag_id),
    CONSTRAINT standard_values_standard_id__fkey FOREIGN KEY (standard_id) REFERENCES shoval.standard_attributes(id),
    CONSTRAINT standard_values_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES shoval.standard_tags(id)
);

CREATE TABLE shoval.materials (
    id character varying(18) NOT NULL,
    description character varying(40),
    center_id integer NOT NULL,
    section_id integer NOT NULL,
    unit_of_measurement character varying(40),
    multiply numeric,
    record_status character varying(20) NOT NULL,
    type character varying(20) NOT NULL,
    CONSTRAINT materials_pkey PRIMARY KEY (id),
    CONSTRAINT fk_materials__material_type_code FOREIGN KEY (type) REFERENCES shoval.material_types(code) ON DELETE CASCADE,
    CONSTRAINT materials_center_id_fkey FOREIGN KEY (center_id) REFERENCES shoval.supply_centers(id) ON DELETE CASCADE,
    CONSTRAINT materials_record_status_fkey FOREIGN KEY (record_status) REFERENCES shoval.record_statuses(id) ON DELETE CASCADE,
    CONSTRAINT materials_section_id_center_id_fkey FOREIGN KEY (section_id, center_id) REFERENCES shoval.supply_sections(id, center_id) ON DELETE CASCADE,
    CONSTRAINT materials_type_fkey FOREIGN KEY (type) REFERENCES shoval.material_types(code) ON DELETE CASCADE
);

CREATE TABLE shoval.materials_nicknames (
    material_id character varying(18) NOT NULL,
    nickname character varying(50),
    CONSTRAINT materialnickname_pkey PRIMARY KEY (material_id),
    CONSTRAINT materialnickname_material_id_fkey FOREIGN KEY (material_id) REFERENCES shoval.materials(id)
);

CREATE TABLE shoval.material_categories (
    material_id character varying(18) NOT NULL,
    main_category character varying(3),
    sub_category character varying(3),
    second_category character varying(3),
    CONSTRAINT materialcategories_pkey PRIMARY KEY (material_id),
    CONSTRAINT materialcategories_main_category_fkey FOREIGN KEY (main_category) REFERENCES shoval.main_categories(id) ON DELETE CASCADE,
    CONSTRAINT materialcategories_material_id_fkey FOREIGN KEY (material_id) REFERENCES shoval.materials(id) ON DELETE CASCADE,
    CONSTRAINT materialcategories_second_category_fkey FOREIGN KEY (second_category) REFERENCES shoval.second_categories(id) ON DELETE CASCADE,
    CONSTRAINT materialcategories_sub_category_fkey FOREIGN KEY (sub_category) REFERENCES shoval.sub_categories(id) ON DELETE CASCADE
);

CREATE TABLE shoval.material_standard_group (
    group_id character varying(9) NOT NULL,
    material_id character varying(18) NOT NULL,
    CONSTRAINT material_standard_group_pkey PRIMARY KEY (group_id, material_id),
    CONSTRAINT material_standard_group_group_id_fkey FOREIGN KEY (group_id) REFERENCES shoval.standard_groups(id),
    CONSTRAINT material_standard_group_material_id_fkey FOREIGN KEY (material_id) REFERENCES shoval.materials(id)
);

CREATE TABLE shoval.category_desc (
    id character varying(9) NOT NULL,
    description character varying(40) NOT NULL,
    category_type character varying NOT NULL,
    is_against_tool boolean,
    CONSTRAINT category_desc_pkey PRIMARY KEY (id),
    CONSTRAINT category_type FOREIGN KEY (category_type) REFERENCES shoval.material_standard_group_types(id)
);

CREATE TABLE shoval.category_groups (
    id character varying(9) NOT NULL,
    group_id character varying(9) NOT NULL,
    CONSTRAINT category_groups_pkey PRIMARY KEY (id, group_id),
    CONSTRAINT category_groups_group_id_fkey FOREIGN KEY (group_id) REFERENCES shoval.standard_groups(id),
    CONSTRAINT category_groups_id_fkey FOREIGN KEY (id) REFERENCES shoval.category_desc(id)
);

CREATE TABLE shoval.units_favorite_materials (
    unit_id integer NOT NULL,
    material_id character varying(18) NOT NULL,
    CONSTRAINT unitfavoritematerials_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES shoval.units_ids(id) ON DELETE CASCADE
);

CREATE TABLE shoval.units_relations (
    unit_id integer NOT NULL,
    unit_object_type character varying(2) NOT NULL,
    related_unit_id integer NOT NULL,
    related_unit_object_type character varying(2) NOT NULL,
    unit_relation_id character varying(10) NOT NULL,
    start_date date NOT NULL,
    end_date date NOT NULL,
    CONSTRAINT unitrelations_pkey PRIMARY KEY (unit_id, unit_object_type, related_unit_id, related_unit_object_type, unit_relation_id, start_date),
    CONSTRAINT unitrelations_related_unit_id_fkey FOREIGN KEY (related_unit_id) REFERENCES shoval.units_ids(id) ON DELETE CASCADE,
    CONSTRAINT unitrelations_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES shoval.units_ids(id) ON DELETE CASCADE,
    CONSTRAINT unitrelations_unit_relation_id_fkey FOREIGN KEY (unit_relation_id) REFERENCES shoval.unit_relation_types(id) ON DELETE CASCADE
);

CREATE SEQUENCE shoval.reports_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

CREATE SEQUENCE shoval.draft_reports_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE shoval.reports_id_seq OWNED BY shoval.reports.id;

CREATE TABLE shoval.reports (
    id integer DEFAULT nextval('shoval.reports_id_seq'::regclass) NOT NULL,
    report_type_id integer NOT NULL,
    unit_id integer NOT NULL,
    unit_object_type character varying(2) NOT NULL,
    recipient_unit_id integer,
    recipient_unit_object_type character varying(2) NOT NULL,
    reporter_unit_id integer,
    reporter_unit_object_type character varying(2) NOT NULL,
    created_on date,
    created_at time without time zone,
    created_by character varying(20),
    CONSTRAINT reports_pkey PRIMARY KEY (id),
    CONSTRAINT reports_report_type_id_unit_id_recipient_unit_id_created_on_key UNIQUE (report_type_id, unit_id, recipient_unit_id, created_on),
    CONSTRAINT reports_created_by_fkey FOREIGN KEY (created_by) REFERENCES shoval.users(id),
    CONSTRAINT reports_recipient_unit_id_fkey FOREIGN KEY (recipient_unit_id) REFERENCES shoval.units_ids(id) ON DELETE CASCADE,
    CONSTRAINT reports_report_type_id_fkey FOREIGN KEY (report_type_id) REFERENCES shoval.report_types(id) ON DELETE CASCADE,
    CONSTRAINT reports_reporter_unit_id_fkey FOREIGN KEY (reporter_unit_id) REFERENCES shoval.units_ids(id) ON DELETE CASCADE,
    CONSTRAINT reports_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES shoval.units_ids(id) ON DELETE CASCADE
);

CREATE TABLE shoval.report_items (
    report_id integer NOT NULL,
    material_id character varying(18) NOT NULL,
    reporting_level integer NOT NULL,
    reporting_unit integer NOT NULL,
    reporting_unit_object_type character varying(2) NOT NULL,
    reported_quantity numeric,
    confirmed_quantity numeric,
    balance_quantity numeric,
    status character varying(20) DEFAULT 'ACTIVE'::character varying,
    changed_at time without time zone,
    changed_by character varying(20),
    modified_at timestamp without time zone,
    CONSTRAINT reportitems_pkey PRIMARY KEY (report_id, material_id, reporting_level),
    CONSTRAINT reportitems_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES shoval.users(id),
    CONSTRAINT reportitems_report_id_fkey FOREIGN KEY (report_id) REFERENCES shoval.reports(id) ON DELETE CASCADE,
    CONSTRAINT reportitems_reporting_level_fkey FOREIGN KEY (reporting_level) REFERENCES shoval.unit_levels(id) ON DELETE CASCADE,
    CONSTRAINT reportitems_reporting_unit_fkey FOREIGN KEY (reporting_unit) REFERENCES shoval.units_ids(id) ON DELETE CASCADE,
    CONSTRAINT reportitems_status_fkey FOREIGN KEY (status) REFERENCES shoval.record_statuses(id) ON DELETE CASCADE
);

CREATE TABLE shoval.draft_reports (
    id integer SERIAL,
    report_type_id integer NOT NULL,
    unit_id integer NOT NULL,
    unit_object_type character varying(2) NOT NULL,
    recipient_unit_id integer,
    recipient_unit_object_type character varying(2) NOT NULL,
    reporter_unit_id integer,
    reporter_unit_object_type character varying(2) NOT NULL,
    created_on date,
    created_at time without time zone,
    created_by character varying(20),
    CONSTRAINT reports_pkey PRIMARY KEY (id),
    CONSTRAINT reports_recipient_unit_id_fkey FOREIGN KEY (recipient_unit_id) REFERENCES shoval.units_ids(id) ON DELETE CASCADE,
    CONSTRAINT reports_report_type_id_fkey FOREIGN KEY (report_type_id) REFERENCES shoval.report_types(id) ON DELETE CASCADE,
    CONSTRAINT reports_reporter_unit_id_fkey FOREIGN KEY (reporter_unit_id) REFERENCES shoval.units_ids(id) ON DELETE CASCADE,
    CONSTRAINT reports_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES shoval.units_ids(id) ON DELETE CASCADE
);

CREATE TABLE shoval.draft_report_items (
    draft_id SERIAL,
    draft_item integer NOT NULL,
    material_description character varying(255),
    material_id character varying(18),
    center_id integer,
    reporting_level integer NOT NULL,
    reporting_unit integer NOT NULL,
    reporting_unit_object_type character varying(2) NOT NULL,
    reported_quantity numeric not null,
    changed_at time without time zone not null,
    changed_by character varying(20) not null,
    modified_at timestamp without time zone not null,
    report_id integer,
    status character varying(20),
    CONSTRAINT draftreportitems_pkey PRIMARY KEY (draft_id, draft_item),
    CONSTRAINT draftreportitems_draft_id_fkey FOREIGN KEY (id) REFERENCES shoval.draft_reports(id) ON DELETE CASCADE,
    CONSTRAINT draftreportitems_center_id_fkey FOREIGN KEY (id) REFERENCES shoval.supply_centers(id) ON DELETE CASCADE,
    CONSTRAINT draftreportitems_material_id_fkey FOREIGN KEY (id) REFERENCES shoval.materials(id) ON DELETE CASCADE
);

CREATE TABLE shoval.stocks (
    material_id character varying(18) NOT NULL,
    unit_id integer NOT NULL,
    date date NOT NULL,
    quantity numeric NOT NULL,
    grade character varying(2) NOT NULL,
    stock_type integer NOT NULL,
    CONSTRAINT stocks_pkey PRIMARY KEY (material_id, unit_id, stock_type, grade, date),
    CONSTRAINT stocks_material_id_fkey FOREIGN KEY (material_id) REFERENCES shoval.materials(id) ON DELETE CASCADE,
    CONSTRAINT stocks_stock_type_fkey FOREIGN KEY (stock_type) REFERENCES shoval.stock_types(id) ON DELETE CASCADE,
    CONSTRAINT stocks_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES shoval.units_ids(id) ON DELETE CASCADE
);

CREATE TABLE shoval.unit_standard_tags (
    unit_id integer NOT NULL,
    tag_id integer NOT NULL,
    CONSTRAINT unit_standard_tags_pkey PRIMARY KEY (unit_id, tag_id),
    CONSTRAINT unit_standard_tags_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES shoval.standard_tags(id) ON DELETE CASCADE,
    CONSTRAINT unit_standard_tags_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES shoval.units_ids(id)
);

CREATE TABLE shoval.comments (
    material_id character varying(18) NOT NULL,
    unit_id integer NOT NULL,
    date date NOT NULL,
    type integer NOT NULL,
    recipient_unit_id integer NOT NULL,
    text character varying,
    CONSTRAINT comments_pkey PRIMARY KEY (unit_id, material_id, date, type, recipient_unit_id),
    CONSTRAINT comments_material_id_fkey FOREIGN KEY (material_id) REFERENCES shoval.materials(id) ON DELETE CASCADE,
    CONSTRAINT comments_recipient_unit_id_fkey FOREIGN KEY (recipient_unit_id) REFERENCES shoval.units_ids(id) ON DELETE CASCADE,
    CONSTRAINT comments_type_fkey FOREIGN KEY (type) REFERENCES shoval.report_types(id) ON DELETE CASCADE,
    CONSTRAINT comments_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES shoval.units_ids(id) ON DELETE CASCADE
);

CREATE TABLE shoval.units_statuses (
    unit_id integer NOT NULL,
    date date NOT NULL,
    unit_status_id integer NOT NULL,
    CONSTRAINT unitsstatuses_pkey PRIMARY KEY (unit_id, date),
    CONSTRAINT unitsstatuses_status_fkey
        FOREIGN KEY (unit_status_id)
        REFERENCES shoval.unit_status_types(id)
        ON DELETE CASCADE,
    CONSTRAINT unitsstatuses_unit_id_fkey
        FOREIGN KEY (unit_id)
        REFERENCES shoval.units_ids(id)
        ON DELETE CASCADE
);

DO $$
BEGIN
  CREATE TYPE shoval.log_type AS ENUM (
    'fatal',
    'error',
    'warning',
    'success'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS shoval.logs (
  id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  application VARCHAR(120) NOT NULL,
  username VARCHAR(120) NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  message TEXT NOT NULL,
  type shoval.log_type NOT NULL,
  request_path VARCHAR(2048),
  request_method VARCHAR(10), 
);

CREATE INDEX IF NOT EXISTS logs_application_idx
  ON shoval.logs (application);

CREATE INDEX IF NOT EXISTS logs_log_type_idx
  ON shoval.logs (type);

CREATE INDEX IF NOT EXISTS logs_occurred_at_idx
  ON shoval.logs (occurred_at DESC);

CREATE INDEX IF NOT EXISTS logs_application_log_type_occurred_at_idx
  ON shoval.logs (application, type, occurred_at DESC);

CREATE UNIQUE INDEX reports_unique ON shoval.reports USING btree (created_on, recipient_unit_id, unit_id, report_type_id);

CREATE INDEX IF NOT EXISTS units_id_idx ON shoval.units USING btree (unit_id);

CREATE INDEX IF NOT EXISTS materials_id_idx ON shoval.materials USING btree (id);

CREATE INDEX IF NOT EXISTS users_id_idx ON shoval.users USING btree (id);

CREATE INDEX IF NOT EXISTS units_relations_unit_id_idx ON shoval.units_relations USING btree (unit_id);

CREATE INDEX IF NOT EXISTS units_relations_related_unit_id_idx ON shoval.units_relations USING btree (related_unit_id);

CREATE INDEX IF NOT EXISTS units_statuses_date_idx ON shoval.units_statuses USING btree (date);