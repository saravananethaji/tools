import type { Finding, ReviewModel, SourceArtifact, TemplateDefinition } from '../model';
import { parseJson, parseRegistration, parseTemplate } from '../parser';
import { buildReview } from '../review';
import { isRegistration, isTemplate } from '../folder';
import {
  SAMPLE_ADAPTER_JSON,
  SAMPLE_TEMPLATE_JSON,
  SAMPLE_ADAPTER_PATH,
  SAMPLE_TEMPLATE_PATH,
  SAMPLE_TEMPLATE_PATH_ALT,
} from './samplePayloads';

export interface ResolvedPayloadFile {
  name: string;
  path: string;
  rawText: string;
  source: 'bundled-sample' | 'folder' | 'upload' | 'pasted';
  fileKind?: 'registration' | 'template' | 'event' | 'unrecognised';
  parsedJson?: unknown;
  parseError?: string;
}

/**
 * Normalizes file paths for matching by stripping leading dots, slashes, and redundant test/resources
 */
export function normalizePath(path: string): string {
  return path
    .replace(/^(\.\/|\/)/, '')
    .replace(/\\/g, '/')
    .replace(/test\/resources\/test\/resources/g, 'test/resources')
    .toLowerCase();
}

/**
 * Matches a target feature file path against a candidate file's relative path or name
 */
export function matchesPath(targetFeaturePath: string, candidateRelativePath: string, candidateName: string): boolean {
  const normTarget = normalizePath(targetFeaturePath);
  const normCandidate = normalizePath(candidateRelativePath);
  const targetName = targetFeaturePath.split('/').pop()?.toLowerCase() || '';
  const candName = candidateName.toLowerCase();

  if (normTarget === normCandidate) return true;
  if (normTarget.endsWith(normCandidate) || normCandidate.endsWith(normTarget)) return true;
  if (targetName && candName && targetName === candName) return true;

  return false;
}

/**
 * Checks if target path corresponds to the bundled sample payloads
 */
export function isSamplePayloadPath(path: string): 'adapter' | 'template' | null {
  const fileName = path.split('/').pop() || path;
  const norm = normalizePath(path);

  if (
    matchesPath(SAMPLE_ADAPTER_PATH, path, fileName) ||
    norm.includes('apitoapiadapterconflayoutpayload') ||
    (norm.includes('02_apitoapi') && norm.includes('adapter'))
  ) {
    return 'adapter';
  }
  if (
    matchesPath(SAMPLE_TEMPLATE_PATH, path, fileName) ||
    matchesPath(SAMPLE_TEMPLATE_PATH_ALT, path, fileName) ||
    norm.includes('apitoapirequestpayload') ||
    (norm.includes('02_apitoapi') && (norm.includes('template') || norm.includes('requestpayload')))
  ) {
    return 'template';
  }
  return null;
}

/**
 * Returns bundled sample files if matched, or ready-to-use sample resolutions
 */
export function getBundledSampleResolutions(): ResolvedPayloadFile[] {
  return [
    {
      name: 'apitoapiadapterconflayoutpayload.json',
      path: SAMPLE_ADAPTER_PATH,
      rawText: SAMPLE_ADAPTER_JSON,
      source: 'bundled-sample',
      fileKind: 'registration',
      parsedJson: JSON.parse(SAMPLE_ADAPTER_JSON),
    },
    {
      name: 'apitoapirequestpayload.json',
      path: SAMPLE_TEMPLATE_PATH,
      rawText: SAMPLE_TEMPLATE_JSON,
      source: 'bundled-sample',
      fileKind: 'template',
      parsedJson: JSON.parse(SAMPLE_TEMPLATE_JSON),
    },
  ];
}

/**
 * Classifies a raw JSON string into registration, template, event, or unrecognised
 */
export function inspectPayloadJson(rawText: string, fileName: string): {
  kind: 'registration' | 'template' | 'event' | 'unrecognised';
  parsed?: unknown;
  error?: string;
  summary?: string;
} {
  try {
    const parsed = JSON.parse(rawText);
    if (isRegistration(parsed)) {
      return {
        kind: 'registration',
        parsed,
        summary: `Adapter Registration: ${parsed.type || 'Unknown Type'} (${parsed.templates?.length || 0} templates)`,
      };
    }
    if (isTemplate(parsed)) {
      return {
        kind: 'template',
        parsed,
        summary: `Template Definition: ${parsed.id} (${parsed.type})`,
      };
    }
    if (parsed && typeof parsed === 'object' && ('eventId' in parsed || 'eventType' in parsed)) {
      return {
        kind: 'event',
        parsed,
        summary: `Event Payload: ${parsed.eventType || parsed.eventId || 'Cloud Event'}`,
      };
    }
    return {
      kind: 'unrecognised',
      parsed,
      summary: 'JSON Object (unrecognized schema for adapter/template)',
    };
  } catch (err) {
    return {
      kind: 'unrecognised',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Builds review models from resolved adapter and template files
 */
export function buildReviewsFromPayloads(
  adapterFile: ResolvedPayloadFile,
  templateFiles: ResolvedPayloadFile[]
): {
  reviews: ReviewModel[];
  findings: Finding[];
  error?: string;
} {
  const allFindings: Finding[] = [];

  // Parse adapter registration
  const regJson = parseJson(adapterFile.rawText, adapterFile.name);
  if (regJson.findings.length) allFindings.push(...regJson.findings);

  if (!regJson.value || !isRegistration(regJson.value)) {
    return {
      reviews: [],
      findings: [
        ...allFindings,
        {
          id: 'INVALID_ADAPTER_JSON',
          severity: 'Invalid',
          category: 'Import',
          artifact: adapterFile.name,
          message: 'The selected adapter file is not a valid Adapter Registration JSON.',
        },
      ],
      error: 'Invalid Adapter Registration JSON format',
    };
  }

  const regParsed = parseRegistration(regJson.value);
  if (regParsed.findings.length) allFindings.push(...regParsed.findings);
  const registration = regParsed.registration;

  if (!registration) {
    return {
      reviews: [],
      findings: allFindings,
      error: 'Could not parse adapter registration details.',
    };
  }

  const registrationSource: SourceArtifact = {
    name: adapterFile.name,
    rawText: adapterFile.rawText,
    parsed: registration,
    role: 'registration',
  };

  const reviews: ReviewModel[] = [];

  // Parse each template
  for (const tplFile of templateFiles) {
    const tplJson = parseJson(tplFile.rawText, tplFile.name);
    if (tplJson.findings.length) allFindings.push(...tplJson.findings);

    if (!tplJson.value || !isTemplate(tplJson.value)) {
      allFindings.push({
        id: 'INVALID_TEMPLATE_JSON',
        severity: 'Invalid',
        category: 'Import',
        artifact: tplFile.name,
        message: `Template file ${tplFile.name} does not match Template Definition JSON structure.`,
      });
      continue;
    }

    const tplParsed = parseTemplate(tplJson.value);
    if (tplParsed.findings.length) allFindings.push(...tplParsed.findings);

    if (!tplParsed.template) continue;

    const templateSource: SourceArtifact = {
      name: tplFile.name,
      rawText: tplFile.rawText,
      parsed: tplJson.value,
      role: 'template',
    };

    // If template IDs do not match directly (e.g. in some cucumber tests where template has a direct route ID),
    // check if registration can accept it or adapt
    let targetTemplate: TemplateDefinition = tplParsed.template;
    const declaredMatch = registration.templates.find(
      t => t.id === targetTemplate.id && t.type === targetTemplate.type
    );

    // If no direct ID match, but registration has exactly 1 template instance of the same type,
    // allow matching with a helpful note so users can review the configuration
    if (!declaredMatch && registration.templates.length === 1) {
      const soleInstance = registration.templates[0];
      if (soleInstance.type === targetTemplate.type) {
        targetTemplate = {
          ...targetTemplate,
          id: soleInstance.id,
        };
      }
    }

    const built = buildReview(
      targetTemplate,
      registration,
      templateSource,
      registrationSource,
      tplParsed.findings
    );

    allFindings.push(...built.findings);
    if (built.review) {
      reviews.push(built.review);
    }
  }

  return {
    reviews,
    findings: allFindings,
    error: reviews.length === 0 ? 'No matching reviews could be assembled from the selected files.' : undefined,
  };
}
