import type { Finding, ReviewModel, SourceArtifact, TemplateDefinition, TemplateInstance } from './model';
import { decodeTemplate, decodeTransformation, effectiveParameters, parseRegistration, parseTemplate, processReferenceFor, routeIdMatches, validateCrossArtifact } from './parser';
import { containsSensitiveContent } from './safety';

export function buildReview(
  template: TemplateDefinition,
  registration: ReturnType<typeof parseRegistration>['registration'],
  templateSource: SourceArtifact,
  registrationSource: SourceArtifact,
  baseFindings: Finding[]
): { review?: ReviewModel; findings: Finding[] } {
  if (!registration) return { findings: baseFindings };
  const matches = registration.templates.filter((item) => item.id === template.id && item.type === template.type);
  if (matches.length !== 1) {
    return {
      findings: [
        ...baseFindings,
        {
          id: matches.length ? 'AMBIGUOUS_MATCH' : 'NO_EXACT_MATCH',
          severity: 'Invalid' as const,
          category: 'Matching',
          artifact: 'registration',
          message: matches.length
            ? `Multiple matching template instances for ${template.id}.`
            : `No matching template instance for ${template.id}.`,
        },
      ],
    };
  }
  // Alert the reviewer to sensitive values in imported raw artifacts without revealing the values.
  const rawSecretScans: Array<{ artifact: 'registration' | 'template'; text: string }> = [
    { artifact: 'registration', text: registrationSource.rawText },
    { artifact: 'template', text: templateSource.rawText },
  ];
  for (const { artifact, text } of rawSecretScans) {
    const id = `RAW_SECRET_${artifact.toUpperCase()}`;
    if (
      containsSensitiveContent(text)
      && !baseFindings.some((f) => f.id === id && f.artifact === artifact)
    ) {
      baseFindings.push({
        id,
        severity: 'Warning',
        category: 'Security',
        artifact,
        message: `Imported ${artifact} contains sensitive values; they are redacted in rendered output.`,
        location: '$',
      });
    }
  }

  const decoded = decodeTemplate(template);
  if (!decoded.decoded) return { findings: [...baseFindings, ...decoded.findings] };
  const parameters = effectiveParameters(template, matches[0], decoded.decoded);
  const transformation = decodeTransformation(matches[0]);
  const findings = [...baseFindings, ...decoded.findings, ...transformation.findings, ...validateCrossArtifact(template, matches[0], decoded.decoded, parameters)];
  const processReference = processReferenceFor(matches[0]);
  const referenceMatches = routeIdMatches(decoded.decoded, processReference);
  const matchedRoute = decoded.decoded.routes.find((route) => route.id === processReference || route.from === processReference);
  const templateReferences = [
    {
      templateId: template.id,
      templateType: template.type,
      templateName: template.name,
      templateFile: templateSource.name,
      resolved: true,
      processReference,
      matchedRouteId: matchedRoute?.id,
      referenceMatchesRouteId: referenceMatches,
    },
  ];
  return {
    review: {
      template,
      registration,
      instance: matches[0],
      templateSource,
      registrationSource,
      decoded: decoded.decoded,
      effectiveParameters: parameters,
      findings,
      transformSpec: transformation.spec,
      transformEngine: transformation.engine,
      templateReferences,
    },
    findings,
  };
}