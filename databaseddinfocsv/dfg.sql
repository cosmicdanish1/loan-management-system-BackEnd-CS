-- Database: employeesociety_new

-- DROP DATABASE IF EXISTS employeesociety_new;

CREATE DATABASE employeesociety_new
    WITH
    OWNER = postgres
    ENCODING = 'UTF8'
    LC_COLLATE = 'English_India.1252'
    LC_CTYPE = 'English_India.1252'
    LOCALE_PROVIDER = 'libc'
    TABLESPACE = pg_default
    CONNECTION LIMIT = -1
    IS_TEMPLATE = False;

COMMENT ON DATABASE employeesociety_new
    IS 'Test DB';