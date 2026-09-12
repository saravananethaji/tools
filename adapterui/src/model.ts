export type Severity = 'Valid' | 'Invalid' | 'Warning' | 'Not verified';

export type Finding = { id: string; severity: Severity; category: string; artifact: string; location?: string; message: string; consequence?: string; suggestedAction?: string };
export type ParameterDeclaration = { name: string; helpText?: string; isMandatory?: string | boolean; raw: Record<string, unknown> };
export type ParameterValue = { name: string; value: string; raw: Record<string, unknown> };
export type TemplateDefinition = { id: string; name: string; type: string; inputParameters: ParameterDeclaration[]; defaultParameters: ParameterValue[]; xmlRoute: string; raw: Record<string, unknown>; unknownFields: Record<string, unknown> };
export type TemplateInstance = { id: string; type: string; inputParameters: ParameterValue[]; defaultParameters: ParameterValue[]; raw: Record<string, unknown>; unknownFields: Record<string, unknown> };
export type AdapterRegistration = { type: string; name: string; status: string; templates: TemplateInstance[]; parameters: Record<string, unknown>; raw: Record<string, unknown>; unknownFields: Record<string, unknown> };
export type SourceArtifact = { name: string; rawText: string; parsed?: unknown; role: 'template' | 'registration' };
export type XmlNode = { name: string; attributes: Record<string, string>; text?: string; location: string; children: XmlNode[] };
export type RouteSummary = { id?: string; from?: string; tree: XmlNode; processors: string[] };
export type ExpressionReference = { kind: 'exchangeProperty' | 'header' | 'body' | 'exchange' | 'exception' | 'unknown'; name?: string; expression: string; location: string };
export type DecodedTemplate = { xml: string; safeXml: string; document: Document; routes: RouteSummary[]; imports: string[]; beans: string[]; endpoints: string[]; references: ExpressionReference[]; securityFindings: Finding[] };
export type EffectiveParameter = { name: string; declaration?: ParameterDeclaration; suppliedValue?: string; registrationDefault?: string; templateDefault?: string; provisionalValue?: string; state: 'Supplied' | 'Registration default' | 'Template default' | 'Missing' | 'Undeclared supplied'; xmlReferences: ExpressionReference[] };
export type ReviewModel = { template: TemplateDefinition; registration: AdapterRegistration; instance: TemplateInstance; templateSource: SourceArtifact; registrationSource: SourceArtifact; decoded: DecodedTemplate; effectiveParameters: EffectiveParameter[]; findings: Finding[]; transformSpec?: unknown; transformEngine?: 'JOLT' | 'XSLT' };
