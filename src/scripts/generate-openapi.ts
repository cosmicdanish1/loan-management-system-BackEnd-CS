/**
 * Generates API documentation artifacts from the NestJS app WITHOUT a database.
 *
 * Uses Nest "preview" mode, which builds the full module/controller graph and
 * registers every route's metadata but never instantiates providers — so no DB
 * connection, no Redis, no side effects. Swagger scans the route metadata via
 * reflection, which is all present in preview mode.
 *
 * Outputs (all under backend/docs/api/):
 *   - openapi.json                     → import into Swagger UI or Postman
 *   - LMS-API.postman_collection.json  → import into Postman (folders per tag)
 *   - API_REFERENCE.md                 → human-readable endpoint list
 *
 * Run:  npm run openapi:generate
 */
import { NestFactory } from '@nestjs/core';
import { SwaggerModule, OpenAPIObject } from '@nestjs/swagger';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { AppModule } from '../app.module';
import { buildSwaggerConfig } from '../config/swagger.config';

// The runtime global prefix (see main.ts: API_PREFIX, default 'api/v1'). The
// OpenAPI paths are prefix-less (e.g. /auth/login); Postman/markdown prepend
// this so requests hit real routes.
const API_PREFIX = process.env.API_PREFIX || 'api/v1';
const DEFAULT_PORT = process.env.PORT || '3000';

const OUT_DIR = join(__dirname, '..', '..', 'docs', 'api');

type AnyObj = Record<string, any>;

async function buildDocument(): Promise<OpenAPIObject> {
  const app = await NestFactory.create(AppModule, {
    preview: true,
    logger: false,
  });
  const document = SwaggerModule.createDocument(app, buildSwaggerConfig());
  await app.close();
  return document;
}

/** Resolve a $ref like "#/components/schemas/CreateMemberDto" to its schema. */
function resolveRef(ref: string, doc: OpenAPIObject): AnyObj | undefined {
  const name = ref.replace('#/components/schemas/', '');
  return (doc.components?.schemas as AnyObj)?.[name];
}

/** A placeholder value for a property, used to seed Postman request bodies. */
function sampleForSchema(schema: AnyObj, doc: OpenAPIObject, depth = 0): any {
  if (!schema || depth > 4) return null;
  if (schema.$ref) return sampleForSchema(resolveRef(schema.$ref, doc) || {}, doc, depth + 1);
  if (schema.example !== undefined) return schema.example;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];

  switch (schema.type) {
    case 'string':
      if (schema.format === 'date-time') return new Date().toISOString();
      if (schema.format === 'date') return new Date().toISOString().slice(0, 10);
      return '';
    case 'number':
    case 'integer':
      return 0;
    case 'boolean':
      return false;
    case 'array':
      return [sampleForSchema(schema.items || {}, doc, depth + 1)].filter((v) => v !== null);
    case 'object':
    default: {
      const props = schema.properties as AnyObj | undefined;
      if (!props) return {};
      const obj: AnyObj = {};
      for (const [key, propSchema] of Object.entries(props)) {
        obj[key] = sampleForSchema(propSchema as AnyObj, doc, depth + 1);
      }
      return obj;
    }
  }
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

interface FlatOp {
  method: HttpMethod;
  path: string; // prefix-less, e.g. /auth/login
  tag: string;
  op: AnyObj;
}

/** Flatten the OpenAPI paths object into a list of operations. */
function flattenOps(doc: OpenAPIObject): FlatOp[] {
  const ops: FlatOp[] = [];
  for (const [path, item] of Object.entries(doc.paths || {})) {
    for (const method of HTTP_METHODS) {
      const op = (item as AnyObj)[method];
      if (!op) continue;
      const tag = (op.tags && op.tags[0]) || path.split('/')[1] || 'default';
      ops.push({ method, path, tag, op });
    }
  }
  return ops;
}

// ---------------------------------------------------------------------------
// Postman collection (schema v2.1.0)
// ---------------------------------------------------------------------------
function toPostman(doc: OpenAPIObject): AnyObj {
  const ops = flattenOps(doc);

  // Group into folders by tag.
  const folders = new Map<string, AnyObj[]>();

  for (const { method, path, tag, op } of ops) {
    if (!folders.has(tag)) folders.set(tag, []);

    // Convert /foo/{id}/bar → segments + Postman :id style, collect path vars.
    const rawSegments = path.split('/').filter(Boolean);
    const segments = rawSegments.map((s) =>
      s.replace(/^\{(.+)\}$/, ':$1'),
    );
    const pathVars = rawSegments
      .filter((s) => /^\{.+\}$/.test(s))
      .map((s) => ({ key: s.slice(1, -1), value: '' }));

    // Query params from the operation.
    const query = (op.parameters || [])
      .filter((p: AnyObj) => p.in === 'query')
      .map((p: AnyObj) => ({
        key: p.name,
        value: '',
        description: p.description || (p.required ? 'required' : 'optional'),
        disabled: !p.required,
      }));

    const prefixSegments = API_PREFIX.split('/').filter(Boolean);
    const fullSegments = [...prefixSegments, ...segments];

    const request: AnyObj = {
      method: method.toUpperCase(),
      header: [],
      url: {
        raw: `{{baseUrl}}/${fullSegments.join('/')}${query.length ? '?' + query.map((q: AnyObj) => `${q.key}=`).join('&') : ''}`,
        host: ['{{baseUrl}}'],
        path: fullSegments,
        ...(query.length ? { query } : {}),
        ...(pathVars.length ? { variable: pathVars } : {}),
      },
      description: [op.summary, op.description].filter(Boolean).join('\n\n') || undefined,
    };

    // Auth: bearer token unless the operation is explicitly public. Login/refresh
    // don't need a token, but sending one is harmless, so keep it uniform.
    request.auth = {
      type: 'bearer',
      bearer: [{ key: 'token', value: '{{token}}', type: 'string' }],
    };

    // Request body from the first application/json content schema.
    const jsonSchema = op.requestBody?.content?.['application/json']?.schema;
    if (jsonSchema) {
      const sample = sampleForSchema(jsonSchema, doc);
      request.header.push({ key: 'Content-Type', value: 'application/json' });
      request.body = {
        mode: 'raw',
        raw: JSON.stringify(sample, null, 2),
        options: { raw: { language: 'json' } },
      };
    }

    folders.get(tag)!.push({
      name: `${method.toUpperCase()} ${path}${op.summary ? ' — ' + op.summary : ''}`,
      request,
      response: [],
    });
  }

  const items = [...folders.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([tag, requests]) => ({
      name: tag,
      item: requests,
    }));

  return {
    info: {
      name: doc.info.title,
      description:
        (doc.info.description || '') +
        `\n\nBase URL variable: {{baseUrl}} = the server root (default http://localhost:${DEFAULT_PORT}). ` +
        `For LAN/emergency access set it to http://<server-ip>:${DEFAULT_PORT}. The /${API_PREFIX} prefix is already baked into every request path.` +
        '\nAuth: set {{token}} to the accessToken from POST /auth/login.',
      version: doc.info.version,
      schema:
        'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    variable: [
      { key: 'baseUrl', value: `http://localhost:${DEFAULT_PORT}`, type: 'string' },
      { key: 'token', value: '', type: 'string' },
    ],
    item: items,
  };
}

// ---------------------------------------------------------------------------
// Markdown reference
// ---------------------------------------------------------------------------
function toMarkdown(doc: OpenAPIObject): string {
  const ops = flattenOps(doc);
  const byTag = new Map<string, FlatOp[]>();
  for (const o of ops) {
    if (!byTag.has(o.tag)) byTag.set(o.tag, []);
    byTag.get(o.tag)!.push(o);
  }

  const tags = [...byTag.keys()].sort((a, b) => a.localeCompare(b));
  const lines: string[] = [];

  lines.push(`# ${doc.info.title} — API Reference`);
  lines.push('');
  lines.push(`Version ${doc.info.version}. Auto-generated from Swagger metadata — do not edit by hand; run \`npm run openapi:generate\`.`);
  lines.push('');
  lines.push(`- **Server root:** \`http://<server-ip>:${DEFAULT_PORT}\` — every path below already includes the \`/${API_PREFIX}\` prefix.`);
  lines.push('- **Auth:** `Authorization: Bearer <accessToken>` (from `POST /auth/login`).');
  lines.push(`- **Total endpoints:** ${ops.length} across ${tags.length} groups.`);
  lines.push('');

  // Table of contents
  lines.push('## Groups');
  lines.push('');
  for (const tag of tags) {
    const anchor = tag.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    lines.push(`- [${tag}](#${anchor}) (${byTag.get(tag)!.length})`);
  }
  lines.push('');

  for (const tag of tags) {
    lines.push(`## ${tag}`);
    lines.push('');
    lines.push('| Method | Path | What it does |');
    lines.push('| --- | --- | --- |');
    const rows = byTag
      .get(tag)!
      .sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
    for (const { method, path, op } of rows) {
      const desc = (op.summary || op.description || '').replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|');
      lines.push(`| \`${method.toUpperCase()}\` | \`/${API_PREFIX}${path}\` | ${desc || '_no description_'} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

async function main() {
  console.log('Building OpenAPI document (preview mode, no DB)...');
  const doc = await buildDocument();

  mkdirSync(OUT_DIR, { recursive: true });

  const openapiPath = join(OUT_DIR, 'openapi.json');
  writeFileSync(openapiPath, JSON.stringify(doc, null, 2));

  const postmanPath = join(OUT_DIR, 'LMS-API.postman_collection.json');
  writeFileSync(postmanPath, JSON.stringify(toPostman(doc), null, 2));

  const mdPath = join(OUT_DIR, 'API_REFERENCE.md');
  writeFileSync(mdPath, toMarkdown(doc));

  const count = flattenOps(doc).length;
  console.log(`✓ ${count} endpoints documented.`);
  console.log(`  - ${openapiPath}`);
  console.log(`  - ${postmanPath}`);
  console.log(`  - ${mdPath}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Failed to generate API docs:', err);
  process.exit(1);
});
