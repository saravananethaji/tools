import type { AdapterRegistration, DecodedTemplate, EffectiveParameter, ExpressionReference, Finding, ParameterDeclaration, ParameterValue, RouteSummary, TemplateDefinition, TemplateInstance, XmlNode } from './model';

export const MAX_FILE_BYTES = 2_000_000;
export const CAMEL_STATIC_RULESET = 'camel-spring-static-v1';
const textDecoder = new TextDecoder('utf-8', { fatal: true });
const knownTemplateKeys = new Set(['id', 'name', 'type', 'inputParameters', 'defaultParameters', 'xmlRoute']);
const knownRegistrationKeys = new Set(['type', 'name', 'status', 'templates', 'parameters']);
const supportedRouteChildren = new Set(['from', 'log', 'choice', 'setHeader', 'setProperty', 'to', 'toD', 'process', 'bean', 'stop', 'marshal', 'unmarshal']);
const supportedContextChildren = new Set(['route', 'onException', 'onCompletion', 'errorHandler']);

const finding = (id: string, severity: Finding['severity'], category: string, artifact: string, message: string, location?: string): Finding => ({ id, severity, category, artifact, message, location });
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const getUnknown = (value: Record<string, unknown>, known: Set<string>) => Object.fromEntries(Object.entries(value).filter(([key]) => !known.has(key)));

export function parseJson(text: string, artifact: string): { value?: unknown; findings: Finding[] } {
  if (new TextEncoder().encode(text).byteLength > MAX_FILE_BYTES) return { findings: [finding('FILE_TOO_LARGE', 'Invalid', 'Import', artifact, `File exceeds ${MAX_FILE_BYTES} bytes.`)] };
  try {
    const value = JSON.parse(text);
    return isObject(value) ? { value, findings: [] } : { findings: [finding('JSON_OBJECT', 'Invalid', 'JSON format', artifact, 'Top-level JSON value must be an object.')] };
  } catch (error) {
    return { findings: [finding('JSON_SYNTAX', 'Invalid', 'JSON format', artifact, `Invalid JSON: ${error instanceof Error ? error.message : 'parse error'}`)] };
  }
}

export function strictBase64Decode(value: string, artifact: string, location: string): { text?: string; findings: Finding[] } {
  if (value.length > MAX_FILE_BYTES || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return { findings: [finding('BASE64_INVALID', 'Invalid', 'Base64', artifact, 'Value is not strictly valid Base64.', location)] };
  try {
    const binary = atob(value);
    if (!binary) return { findings: [finding('BASE64_EMPTY', 'Invalid', 'Base64', artifact, 'Decoded content is empty.', location)] };
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (bytes.byteLength > MAX_FILE_BYTES) return { findings: [finding('DECODED_TOO_LARGE', 'Invalid', 'Base64', artifact, `Decoded content exceeds ${MAX_FILE_BYTES} bytes.`, location)] };
    return { text: textDecoder.decode(bytes), findings: [] };
  } catch {
    return { findings: [finding('BASE64_DECODE', 'Invalid', 'Base64', artifact, 'Base64 decoding failed or content is not valid UTF-8.', location)] };
  }
}

function parseValues(value: unknown, artifact: string, location: string): { values: ParameterValue[]; findings: Finding[] } {
  if (!Array.isArray(value)) return { values: [], findings: [finding('PARAMETERS_SHAPE', 'Invalid', 'Schema', artifact, 'Parameter values must be an array.', location)] };
  const seen = new Set<string>(); const values: ParameterValue[] = []; const findings: Finding[] = [];
  value.forEach((entry, index) => {
    if (!isObject(entry) || typeof entry.name !== 'string' || typeof entry.value !== 'string') { findings.push(finding('PARAM_VALUE_SHAPE', 'Invalid', 'Schema', artifact, 'Parameter value requires string name and value.', `${location}[${index}]`)); return; }
    if (seen.has(entry.name)) findings.push(finding('PARAM_VALUE_DUPLICATE', 'Invalid', 'Schema', artifact, `Duplicate parameter value: ${entry.name}`, `${location}[${index}]`));
    seen.add(entry.name); values.push({ name: entry.name, value: entry.value, raw: entry });
  });
  return { values, findings };
}

export function parseTemplate(value: unknown): { template?: TemplateDefinition; findings: Finding[] } {
  if (!isObject(value) || typeof value.id !== 'string' || typeof value.name !== 'string' || typeof value.type !== 'string' || !Array.isArray(value.inputParameters) || !Array.isArray(value.defaultParameters) || typeof value.xmlRoute !== 'string') return { findings: [finding('TEMPLATE_SHAPE', 'Invalid', 'Schema', 'template', 'Template requires string id/name/type/xmlRoute and inputParameters/defaultParameters arrays.')] };
  const findings: Finding[] = []; const seen = new Set<string>(); const inputParameters: ParameterDeclaration[] = [];
  value.inputParameters.forEach((entry, index) => {
    if (!isObject(entry) || typeof entry.name !== 'string' || (entry.helpText !== undefined && typeof entry.helpText !== 'string') || (entry.isMandatory !== undefined && typeof entry.isMandatory !== 'string' && typeof entry.isMandatory !== 'boolean')) { findings.push(finding('PARAM_DECLARATION_SHAPE', 'Invalid', 'Schema', 'template', 'Parameter declaration requires a name and valid optional metadata.', `$.inputParameters[${index}]`)); return; }
    if (seen.has(entry.name)) findings.push(finding('PARAM_DECLARATION_DUPLICATE', 'Invalid', 'Schema', 'template', `Duplicate parameter declaration: ${entry.name}`, `$.inputParameters[${index}]`));
    seen.add(entry.name); inputParameters.push({ name: entry.name, helpText: entry.helpText as string | undefined, isMandatory: entry.isMandatory as string | boolean | undefined, raw: entry });
  });
  const defaults = parseValues(value.defaultParameters, 'template', '$.defaultParameters'); findings.push(...defaults.findings);
  return { template: { id: value.id, name: value.name, type: value.type, inputParameters, defaultParameters: defaults.values, xmlRoute: value.xmlRoute, raw: value, unknownFields: getUnknown(value, knownTemplateKeys) }, findings };
}

export function parseRegistration(value: unknown): { registration?: AdapterRegistration; findings: Finding[] } {
  if (!isObject(value) || typeof value.type !== 'string' || typeof value.name !== 'string' || typeof value.status !== 'string' || !Array.isArray(value.templates)) return { findings: [finding('REGISTRATION_SHAPE', 'Invalid', 'Schema', 'registration', 'Registration requires string type/name/status and a templates array.')] };
  const findings: Finding[] = []; const templates: TemplateInstance[] = [];
  value.templates.forEach((entry, index) => {
    if (!isObject(entry) || typeof entry.id !== 'string' || typeof entry.type !== 'string') { findings.push(finding('TEMPLATE_INSTANCE_SHAPE', 'Invalid', 'Schema', 'registration', 'Template instance requires string id and type.', `$.templates[${index}]`)); return; }
    const supplied = parseValues(entry.inputParameters, 'registration', `$.templates[${index}].inputParameters`);
    const defaults = parseValues(entry.defaultParameters, 'registration', `$.templates[${index}].defaultParameters`);
    findings.push(...supplied.findings, ...defaults.findings);
    templates.push({ id: entry.id, type: entry.type, inputParameters: supplied.values, defaultParameters: defaults.values, raw: entry, unknownFields: getUnknown(entry, new Set(['id', 'type', 'inputParameters', 'defaultParameters'])) });
  });
  if (value.parameters !== undefined && !isObject(value.parameters)) findings.push(finding('REGISTRATION_PARAMETERS_SHAPE', 'Invalid', 'Schema', 'registration', 'Top-level parameters must be an object.', '$.parameters'));
  return { registration: { type: value.type, name: value.name, status: value.status, templates, parameters: isObject(value.parameters) ? value.parameters : {}, raw: value, unknownFields: getUnknown(value, knownRegistrationKeys) }, findings };
}

function redactSecrets(xml: string): string { return xml.replace(/(\b(?:password|keyPassword|secret|token)\s*=\s*["'])[^"']*(["'])/gi, '$1[REDACTED]$2'); }
function nodeLocation(element: Element): string { return `<${element.localName || element.nodeName}${element.getAttribute('id') ? ` id="${element.getAttribute('id')}"` : ''}>`; }
function toTree(element: Element): XmlNode { return { name: element.localName || element.nodeName, attributes: Object.fromEntries(Array.from(element.attributes).map((attribute) => [attribute.name, attribute.value])), text: Array.from(element.childNodes).filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent?.trim() ?? '').filter(Boolean).join(' ') || undefined, location: nodeLocation(element), children: Array.from(element.children).map(toTree) }; }

function expressionReferences(xml: string): ExpressionReference[] {
  return [...xml.matchAll(/\$\{([^}]+)\}/g)].map((match) => {
    const expression = match[1].trim(); const location = `offset ${match.index ?? 0}`;
    const exchangeProperty = expression.match(/^exchangeProperty\.([A-Za-z0-9_.-]+)/);
    const header = expression.match(/^header\.([A-Za-z0-9_.-]+)/);
    if (exchangeProperty) return { kind: 'exchangeProperty', name: exchangeProperty[1], expression, location };
    if (header) return { kind: 'header', name: header[1], expression, location };
    if (/^body(?:[.[]|$)/.test(expression)) return { kind: 'body', expression, location };
    if (/^exchange(?:[.[]|$)/.test(expression)) return { kind: 'exchange', expression, location };
    if (/^exception(?:[?.[]|$)/.test(expression)) return { kind: 'exception', expression, location };
    return { kind: 'unknown', expression, location };
  });
}

export function decodeTemplate(template: TemplateDefinition): { decoded?: DecodedTemplate; findings: Finding[] } {
  const decoded = strictBase64Decode(template.xmlRoute, 'template', '$.xmlRoute'); if (!decoded.text) return { findings: decoded.findings };
  if (/<\!DOCTYPE|<\!ENTITY/i.test(decoded.text)) return { findings: [...decoded.findings, finding('XML_EXTERNAL', 'Invalid', 'Security', 'template', 'DTD and external entities are prohibited.', '$.xmlRoute')] };
  const document = new DOMParser().parseFromString(decoded.text, 'application/xml');
  if (document.querySelector('parsererror')) return { findings: [...decoded.findings, finding('XML_MALFORMED', 'Invalid', 'XML format', 'template', 'Decoded xmlRoute is not well-formed XML.', '$.xmlRoute')] };
  const findings: Finding[] = [...decoded.findings]; const root = document.documentElement;
  if (root.localName !== 'beans' || root.namespaceURI !== 'http://www.springframework.org/schema/beans') findings.push(finding('XML_ROOT', 'Invalid', 'XML format', 'template', 'Root element must be Spring Beans <beans>.', nodeLocation(root)));
  if (!root.getAttribute('xmlns:camel') || !root.getAttribute('xsi:schemaLocation')) findings.push(finding('XML_NAMESPACE', 'Warning', 'XML format', 'template', 'Camel namespace or schemaLocation is absent; version-specific checks are not verified.', nodeLocation(root)));
  const routes: RouteSummary[] = Array.from(document.getElementsByTagNameNS('*', 'route')).map((route) => ({ id: route.getAttribute('id') ?? undefined, from: Array.from(route.children).find((child) => child.localName === 'from')?.getAttribute('uri') ?? undefined, processors: Array.from(route.children).map((node) => node.localName ?? node.nodeName), tree: toTree(route) }));
  const seen = new Set<string>(); routes.forEach((route) => { if (!route.id) findings.push(finding('ROUTE_ID_REQUIRED', 'Invalid', 'Camel DSL', 'template', 'Every route requires an id.', route.tree.location)); else if (seen.has(route.id)) findings.push(finding('ROUTE_ID_DUPLICATE', 'Invalid', 'Camel DSL', 'template', `Duplicate route id: ${route.id}`, route.tree.location)); else seen.add(route.id); if (!route.from) findings.push(finding('ROUTE_FROM_REQUIRED', 'Invalid', 'Camel DSL', 'template', 'Every route requires a direct child <from uri="...">.', route.tree.location)); });
  Array.from(document.getElementsByTagNameNS('*', 'camelContext')).forEach((context) => Array.from(context.children).forEach((child) => { if (!supportedContextChildren.has(child.localName)) findings.push(finding('DSL_CONTEXT_UNSUPPORTED', 'Warning', 'Camel DSL', 'template', `Unsupported camelContext child: <${child.localName}>.`, nodeLocation(child))); }));
  routes.forEach((route) => route.tree.children.forEach((child) => { if (!supportedRouteChildren.has(child.name)) findings.push(finding('DSL_ROUTE_UNSUPPORTED', 'Warning', 'Camel DSL', 'template', `Unsupported route child: <${child.name}>.`, child.location)); }));
  Array.from(document.querySelectorAll('choice')).forEach((choice) => { const whens = Array.from(choice.children).filter((child) => child.localName === 'when'); const otherwise = Array.from(choice.children).filter((child) => child.localName === 'otherwise'); if (!whens.length || otherwise.length > 1) findings.push(finding('DSL_CHOICE_STRUCTURE', 'Invalid', 'Camel DSL', 'template', 'choice requires at least one when and at most one otherwise.', nodeLocation(choice))); });
  Array.from(document.querySelectorAll('[uri],to,toD,from')).forEach((element) => { const uri = element.getAttribute('uri'); if (!uri) findings.push(finding('DSL_URI_REQUIRED', 'Invalid', 'Camel DSL', 'template', `<${element.localName}> requires uri.`, nodeLocation(element))); else if ((uri.match(/\$\{/g) ?? []).length !== (uri.match(/\}/g) ?? []).length) findings.push(finding('DSL_URI_PLACEHOLDER', 'Invalid', 'Camel DSL', 'template', `Unbalanced dynamic placeholder in URI.`, nodeLocation(element))); });
  Array.from(document.querySelectorAll('simple')).forEach((element) => { if (!(element.textContent?.trim())) findings.push(finding('DSL_SIMPLE_EMPTY', 'Invalid', 'Camel DSL', 'template', 'simple expression must not be empty.', nodeLocation(element))); });
  const imports = Array.from(document.getElementsByTagNameNS('*', 'import')).map((node) => node.getAttribute('resource') ?? '');
  const beans = Array.from(document.getElementsByTagNameNS('*', 'bean')).map((node) => node.getAttribute('id') ?? node.getAttribute('ref') ?? '');
  const endpoints = Array.from(document.querySelectorAll('[uri]')).map((node) => node.getAttribute('uri')!).filter(Boolean);
  const securityFindings = /\b(?:password|keyPassword|secret|token)\s*=\s*["']/i.test(decoded.text) ? [finding('INLINE_SECRET', 'Warning', 'Security', 'template', 'Potential inline credential detected; rendered values are redacted.', '$.xmlRoute')] : [];
  findings.push(...securityFindings, finding('DSL_RULESET', 'Not verified', 'Camel DSL', 'template', `Static checks use ${CAMEL_STATIC_RULESET}; the deployed Camel schema version is not verified.`));
  return { decoded: { xml: decoded.text, safeXml: redactSecrets(decoded.text), document, routes, imports, beans, endpoints, references: expressionReferences(decoded.text), securityFindings }, findings };
}

export function effectiveParameters(template: TemplateDefinition, instance: TemplateInstance, decoded: DecodedTemplate): EffectiveParameter[] {
  const supplied = new Map(instance.inputParameters.map((value) => [value.name, value.value])); const registrationDefaults = new Map(instance.defaultParameters.map((value) => [value.name, value.value])); const templateDefaults = new Map(template.defaultParameters.map((value) => [value.name, value.value])); const declarations = new Map(template.inputParameters.map((declaration) => [declaration.name, declaration])); const names = new Set([...declarations.keys(), ...templateDefaults.keys(), ...registrationDefaults.keys()]);
  const parameters: EffectiveParameter[] = Array.from(names).map((name): EffectiveParameter => {
    const declaration = declarations.get(name); const suppliedValue = supplied.get(name); const registrationDefault = registrationDefaults.get(name); const templateDefault = templateDefaults.get(name); const provisionalValue = suppliedValue ?? registrationDefault ?? templateDefault;
    return { name, declaration, suppliedValue, registrationDefault, templateDefault, provisionalValue, state: suppliedValue ? 'Supplied' : registrationDefault ? 'Registration default' : templateDefault ? 'Template default' : 'Missing', xmlReferences: decoded.references.filter((reference) => reference.kind === 'exchangeProperty' && reference.name === name) };
  });
  instance.inputParameters.filter((value) => !names.has(value.name)).forEach((value) => parameters.push({ name: value.name, suppliedValue: value.value, registrationDefault: undefined, templateDefault: undefined, provisionalValue: undefined, state: 'Undeclared supplied', xmlReferences: decoded.references.filter((reference) => reference.kind === 'exchangeProperty' && reference.name === value.name) }));
  return parameters;
}

export function validateCrossArtifact(template: TemplateDefinition, instance: TemplateInstance, decoded: DecodedTemplate, parameters: EffectiveParameter[]): Finding[] {
  const findings: Finding[] = [];
  parameters.forEach((parameter) => {
    if (parameter.state === 'Undeclared supplied') findings.push(finding('PARAM_UNDECLARED', 'Warning', 'Cross-artifact', 'registration', `Supplied parameter is not declared by the template: ${parameter.name}`));
    if (parameter.declaration && (parameter.declaration.isMandatory === true || parameter.declaration.isMandatory === 'true') && !parameter.provisionalValue) findings.push(finding('PARAM_MISSING', 'Invalid', 'Cross-artifact', 'registration', `Mandatory parameter is missing: ${parameter.name}`));
    if (parameter.declaration && !parameter.xmlReferences.length) findings.push(finding('PARAM_UNUSED', 'Warning', 'Cross-artifact', 'template', `Declared parameter is not referenced by Camel XML: ${parameter.name}`));
  });
  decoded.references.filter((reference) => reference.kind === 'exchangeProperty' && !parameters.some((parameter) => parameter.name === reference.name)).forEach((reference) => findings.push(finding('XML_REF_UNDECLARED', 'Warning', 'Cross-artifact', 'template', `Camel XML references undeclared Exchange property: ${reference.name}`, reference.location)));
  findings.push(finding('RUNTIME_UNVERIFIED', 'Not verified', 'Runtime', 'combined', 'Static validation does not verify runtime beans, Camel components, endpoint connectivity, route execution, or parameter precedence.'));
  return findings;
}

export function decodeTransformation(instance: TemplateInstance): { spec?: unknown; engine?: 'JOLT' | 'XSLT'; findings: Finding[] } {
  const entry = instance.inputParameters.find((parameter) => /(?:data\.)?(?:jolt|xslt)\.transform\.spec|data\.transform\.spec/i.test(parameter.name));
  if (!entry) return { findings: [finding('TRANSFORM_MISSING', 'Not verified', 'Transformation', 'registration', 'No transformation specification parameter was found.')] };
  const engine = entry.name.toLowerCase().includes('xslt') ? 'XSLT' : 'JOLT'; const decoded = strictBase64Decode(entry.value, 'registration', `parameter:${entry.name}`); if (!decoded.text) return { engine, findings: decoded.findings };
  if (engine === 'JOLT') { try { return { engine, spec: JSON.parse(decoded.text), findings: [] }; } catch { return { engine, findings: [finding('JOLT_INVALID', 'Invalid', 'Transformation', 'registration', 'JOLT specification is not valid JSON.', `parameter:${entry.name}`)] }; } }
  if (/<\!DOCTYPE|<\!ENTITY/i.test(decoded.text)) return { engine, findings: [finding('XSLT_EXTERNAL', 'Invalid', 'Transformation', 'registration', 'DTD and external entities are prohibited in XSLT.', `parameter:${entry.name}`)] };
  const document = new DOMParser().parseFromString(decoded.text, 'application/xml');
  if (document.querySelector('parsererror') || document.documentElement.localName !== 'stylesheet' || document.documentElement.namespaceURI !== 'http://www.w3.org/1999/XSL/Transform') return { engine, findings: [finding('XSLT_INVALID', 'Invalid', 'Transformation', 'registration', 'Transformation is not a well-formed XSLT stylesheet.', `parameter:${entry.name}`)] };
  return { engine, spec: decoded.text, findings: [] };
}
