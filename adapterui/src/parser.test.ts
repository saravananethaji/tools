import { describe, expect, it } from 'vitest';
import { decodeTemplate, decodeTransformation, effectiveParameters, parseJson, parseRegistration, parseTemplate, strictBase64Decode, validateCrossArtifact } from './parser';

const xml = '<beans xmlns="http://www.springframework.org/schema/beans" xmlns:camel="http://camel.apache.org/schema/spring" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="x"><camelContext xmlns="http://camel.apache.org/schema/spring"><route id="r"><from uri="direct:start"/><choice><when><simple>${exchangeProperty.httpEndPoint} != ""</simple><to uri="http://example.test"/></when></choice></route></camelContext></beans>';
const templateInput = { id: 'direct:test', name: 'Test', type: 'PROCESS', inputParameters: [{ name: 'httpEndPoint', helpText: 'Endpoint', isMandatory: 'true' }], defaultParameters: [{ name: 'timeout', value: '10' }], xmlRoute: btoa(xml) };
const registrationInput = { type: 'EVENTTOAPI', name: 'Demo', status: 'STOP', templates: [{ id: 'direct:test', type: 'PROCESS', inputParameters: [{ name: 'httpEndPoint', value: 'http://example.test' }], defaultParameters: [] }], parameters: {} };
const template = () => parseTemplate(templateInput).template!;
const registration = () => parseRegistration(registrationInput).registration!;

describe('static review parser', () => {
  it('parses and matches a valid contract', () => {
    const decoded = decodeTemplate(template()).decoded!; const instance = registration().templates[0]; const parameters = effectiveParameters(template(), instance, decoded);
    expect(decoded.routes[0].from).toBe('direct:start'); expect(parameters[0].xmlReferences).toHaveLength(1); expect(validateCrossArtifact(template(), instance, decoded, parameters).some((item) => item.id === 'PARAM_MISSING')).toBe(false);
  });
  it('rejects malformed JSON, Base64, XML, and DTD before XML parsing', () => {
    expect(parseJson('{', 'test').findings[0].id).toBe('JSON_SYNTAX');
    expect(strictBase64Decode('not base64!', 'test', '$').findings[0].id).toBe('BASE64_INVALID');
    expect(decodeTemplate({ ...template(), xmlRoute: btoa('<beans>') }).findings.some((item) => item.id === 'XML_MALFORMED')).toBe(true);
    expect(decodeTemplate({ ...template(), xmlRoute: btoa('<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><beans/>') }).findings.some((item) => item.id === 'XML_EXTERNAL')).toBe(true);
  });
  it('finds duplicate route IDs and invalid choice structure', () => {
    const invalid = '<beans xmlns="http://www.springframework.org/schema/beans"><camelContext xmlns="http://camel.apache.org/schema/spring"><route id="same"><from uri="direct:a"/></route><route id="same"><from uri="direct:b"/></route><route id="choice"><from uri="direct:c"/><choice><otherwise/></choice></route></camelContext></beans>';
    const result = decodeTemplate({ ...template(), xmlRoute: btoa(invalid) });
    expect(result.findings.some((item) => item.id === 'ROUTE_ID_DUPLICATE')).toBe(true); expect(result.findings.some((item) => item.id === 'DSL_CHOICE_STRUCTURE')).toBe(true);
  });
  it('validates nested registration objects instead of casting them', () => {
    const bad = parseRegistration({ ...registrationInput, templates: [{ id: 'x', type: 'PROCESS', inputParameters: 'not-array', defaultParameters: [] }] });
    expect(bad.findings.some((item) => item.id === 'PARAMETERS_SHAPE')).toBe(true); expect(bad.registration?.templates[0].inputParameters).toEqual([]);
  });
  it('uses template defaults provisionally and keeps undeclared values distinct', () => {
    const decoded = decodeTemplate(template()).decoded!; const instance = { ...registration().templates[0], inputParameters: [...registration().templates[0].inputParameters, { name: 'unknown', value: 'x', raw: { name: 'unknown', value: 'x' } }] };
    const parameters = effectiveParameters(template(), instance, decoded);
    expect(parameters.find((item) => item.name === 'timeout')?.state).toBe('Template default'); expect(parameters.find((item) => item.name === 'unknown')?.state).toBe('Undeclared supplied');
  });
  it('validates JOLT and XSLT without executing transformations', () => {
    const joltInstance = { ...registration().templates[0], inputParameters: [{ name: 'data.transform.spec', value: btoa('{"operation":"shift"}'), raw: {} }] };
    expect(decodeTransformation(joltInstance).engine).toBe('JOLT');
    const xsltInstance = { ...registration().templates[0], inputParameters: [{ name: 'xslt.transform.spec', value: btoa('<xsl:stylesheet xmlns:xsl="http://www.w3.org/1999/XSL/Transform" version="1.0"/>'), raw: {} }] };
    expect(decodeTransformation(xsltInstance).engine).toBe('XSLT');
    expect(decodeTransformation({ ...xsltInstance, inputParameters: [{ name: 'xslt.transform.spec', value: btoa('<not-xslt/>'), raw: {} }] }).findings[0].id).toBe('XSLT_INVALID');
  });
  it('preserves unknown fields while reporting duplicate parameter declarations and values', () => {
    const parsedTemplate = parseTemplate({ ...templateInput, owner: 'payments', inputParameters: [...templateInput.inputParameters, { name: 'httpEndPoint' }], defaultParameters: [{ name: 'timeout', value: '10' }, { name: 'timeout', value: '20' }] });
    const parsedRegistration = parseRegistration({ ...registrationInput, deployment: { region: 'in' }, templates: [{ ...registrationInput.templates[0], inputParameters: [...registrationInput.templates[0].inputParameters, { name: 'httpEndPoint', value: 'duplicate' }] }] });
    expect(parsedTemplate.template?.unknownFields.owner).toBe('payments');
    expect(parsedTemplate.findings.map((item) => item.id)).toEqual(expect.arrayContaining(['PARAM_DECLARATION_DUPLICATE', 'PARAM_VALUE_DUPLICATE']));
    expect(parsedRegistration.registration?.unknownFields.deployment).toEqual({ region: 'in' });
    expect(parsedRegistration.findings.some((item) => item.id === 'PARAM_VALUE_DUPLICATE')).toBe(true);
  });
  it('rejects non-object JSON and malformed registration/template roots', () => {
    expect(parseJson('[]', 'array.json').findings[0].id).toBe('JSON_OBJECT');
    expect(parseTemplate({ ...templateInput, xmlRoute: undefined }).findings[0].id).toBe('TEMPLATE_SHAPE');
    expect(parseRegistration({ ...registrationInput, status: 200 }).findings[0].id).toBe('REGISTRATION_SHAPE');
    expect(parseRegistration({ ...registrationInput, parameters: [] }).findings.some((item) => item.id === 'REGISTRATION_PARAMETERS_SHAPE')).toBe(true);
  });
  it('rejects non-UTF-8 and empty Base64 values', () => {
    expect(strictBase64Decode('', 'test', '$').findings[0].id).toBe('BASE64_EMPTY');
    expect(strictBase64Decode('/w==', 'test', '$').findings[0].id).toBe('BASE64_DECODE');
  });
  it('reports required route parts, unsupported DSL nodes, bad URIs, and empty Simple expressions', () => {
    const invalid = '<beans xmlns="http://www.springframework.org/schema/beans"><camelContext xmlns="http://camel.apache.org/schema/spring"><route><to/><wireTap uri="direct:${broken"/><simple> </simple></route><rest/></camelContext></beans>';
    const ids = decodeTemplate({ ...template(), xmlRoute: btoa(invalid) }).findings.map((item) => item.id);
    expect(ids).toEqual(expect.arrayContaining(['ROUTE_ID_REQUIRED', 'ROUTE_FROM_REQUIRED', 'DSL_ROUTE_UNSUPPORTED', 'DSL_CONTEXT_UNSUPPORTED', 'DSL_URI_REQUIRED', 'DSL_URI_PLACEHOLDER', 'DSL_SIMPLE_EMPTY']));
  });
  it('reports missing, unused, and XML-only Exchange-property references without confusing headers', () => {
    const source = '<beans xmlns="http://www.springframework.org/schema/beans"><camelContext xmlns="http://camel.apache.org/schema/spring"><route id="r"><from uri="direct:start"/><setHeader name="x"><simple>${header.customerId}</simple></setHeader><simple>${exchangeProperty.undeclared}</simple></route></camelContext></beans>';
    const parsedTemplate = parseTemplate({ ...templateInput, inputParameters: [{ name: 'requiredButUnused', isMandatory: true }], xmlRoute: btoa(source) }).template!;
    const decoded = decodeTemplate(parsedTemplate).decoded!; const instance = registration().templates[0]; const parameters = effectiveParameters(parsedTemplate, instance, decoded); const ids = validateCrossArtifact(parsedTemplate, instance, decoded, parameters).map((item) => item.id);
    expect(decoded.references.some((reference) => reference.kind === 'header' && reference.name === 'customerId')).toBe(true);
    expect(ids).toEqual(expect.arrayContaining(['PARAM_MISSING', 'PARAM_UNUSED', 'PARAM_UNDECLARED', 'XML_REF_UNDECLARED']));
  });
  it('rejects external entities and malformed JOLT/XSLT transformations', () => {
    const instance = registration().templates[0];
    expect(decodeTransformation({ ...instance, inputParameters: [{ name: 'xslt.transform.spec', value: btoa('<!DOCTYPE x [<!ENTITY e SYSTEM "file:///x">]><xsl:stylesheet xmlns:xsl="http://www.w3.org/1999/XSL/Transform"/>'), raw: {} }] }).findings[0].id).toBe('XSLT_EXTERNAL');
    expect(decodeTransformation({ ...instance, inputParameters: [{ name: 'data.transform.spec', value: btoa('{bad'), raw: {} }] }).findings[0].id).toBe('JOLT_INVALID');
    expect(decodeTransformation({ ...instance, inputParameters: [] }).findings[0].id).toBe('TRANSFORM_MISSING');
  });
});
