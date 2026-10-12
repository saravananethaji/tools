export type Severity = 'Valid' | 'Invalid' | 'Warning' | 'Not verified';

/**
 * `scope` decides who owns a finding:
 *  - `'catalog'` — belongs to the folder as a whole (duplicate files, orphan templates, files that cannot be
 *    decoded or parsed but are not the declared template of any entry). Rendered once at catalog level and
 *    never charged to a card's health.
 *  - `'registration'`, or absent (the default) — belongs to the registration named by `registrationPath`.
 *    A registration-scoped finding with no `registrationPath` (e.g. the standing ruleset notice) is shown to
 *    the reviewer but is not charged to any card.
 *
 * The distinction exists so that one use case's problem can never appear on another use case's card.
 */
export type FindingScope = 'catalog' | 'registration';

export type Finding = { id: string; severity: Severity; category: string; artifact: string; location?: string; message: string; consequence?: string; suggestedAction?: string; registrationPath?: string; scope?: FindingScope };
export type ParameterDeclaration = { name: string; helpText?: string; isMandatory?: string | boolean; raw: Record<string, unknown> };
export type ParameterValue = { name: string; value: string; raw: Record<string, unknown> };
export type TemplateDefinition = { id: string; name: string; type: string; inputParameters: ParameterDeclaration[]; defaultParameters: ParameterValue[]; xmlRoute: string; raw: Record<string, unknown>; unknownFields: Record<string, unknown> };
export type TemplateInstance = { id: string; type: string; inputParameters: ParameterValue[]; defaultParameters: ParameterValue[]; raw: Record<string, unknown>; unknownFields: Record<string, unknown> };
export type AdapterRegistration = { type: string; name: string; status: string; templates: TemplateInstance[]; parameters: Record<string, unknown>; raw: Record<string, unknown>; unknownFields: Record<string, unknown> };
export type SourceArtifact = { name: string; rawText: string; parsed?: unknown; role: 'template' | 'registration' };
export type XmlNode = { name: string; attributes: Record<string, string>; text?: string; location: string; children: XmlNode[] };
export type RouteSummary = { id?: string; from?: string; tree: XmlNode; processors: string[] };
export type ExpressionReference = { kind: 'exchangeProperty' | 'header' | 'body' | 'exchange' | 'exception' | 'unknown'; name?: string; expression: string; routeId?: string; step: string; purpose: string; location: string };
export type DecodedTemplate = { xml: string; safeXml: string; document: Document; routes: RouteSummary[]; imports: string[]; beans: string[]; endpoints: string[]; references: ExpressionReference[]; securityFindings: Finding[] };
export type EffectiveParameter = { name: string; declaration?: ParameterDeclaration; suppliedValue?: string; registrationDefault?: string; templateDefault?: string; provisionalValue?: string; state: 'Supplied' | 'Registration default' | 'Template default' | 'Missing' | 'Undeclared supplied'; xmlReferences: ExpressionReference[] };
export type TemplateReference = {
  templateId: string;
  templateType: string;
  templateName?: string;
  templateFile?: string;
  resolved: boolean;
  processReference: string;
  matchedRouteId?: string;
  referenceMatchesRouteId: boolean;
};
export type ReviewModel = { template: TemplateDefinition; registration: AdapterRegistration; instance: TemplateInstance; templateSource: SourceArtifact; registrationSource: SourceArtifact; decoded: DecodedTemplate; effectiveParameters: EffectiveParameter[]; findings: Finding[]; transformSpec?: unknown; transformEngine?: 'JOLT' | 'XSLT'; templateReferences?: TemplateReference[] };

// New types for the folder browser feature
export type FileKind = 'registration' | 'template' | 'sample' | 'raw-xml' | 'unrecognised';

export type FolderEntry = {
  relativePath: string;
  name: string;
  kind: FileKind;
  text?: string;
  parsed?: unknown;
  sourceArtifact: SourceArtifact;
  notes: string[];
};

export type FolderScan = {
  entries: FolderEntry[];
  findings: Finding[];
  truncated: boolean;
  fileCount: number;
  totalBytes: number;
};

export type StageRow = {
  entryType: string;
  entryId: string;
  templateFilePath?: string;
  matched: boolean;
  processReference: string;
};

export type UseCase = {
  registration: AdapterRegistration;
  registrationPath: string;
  stages: StageRow[];
  templatePaths: string[];
  missing: Array<{ id: string; type: string }>;
  extra: string[];
  duplicates: string[];
  health: 'Healthy' | 'Warnings' | 'Errors' | 'Not verified';
  findingGroups: Array<{ id: string; severity: Severity; count: number }>;
  findings: Finding[];
};

export type CatalogModel = {
  useCases: UseCase[];
  sideItems: FolderEntry[];
  findings: Finding[];
  truncated: boolean;
};

// Labels for side-item kinds (for display)
export const FileKindLabels: Record<FileKind, string> = {
  registration: 'Registration',
  template: 'Template',
  sample: 'Sample',
  'raw-xml': 'Raw XML',
  unrecognised: 'Unrecognised',
};
