import type {
  Finding,
  SourceArtifact,
  AdapterRegistration,
  TemplateDefinition,
  Severity,
  FileKind,
  FolderEntry,
  FolderScan,
  StageRow,
  UseCase,
  CatalogModel,
} from './model';
import { processReferenceFor, parseJson, parseRegistration } from './parser';

// Folder-browser types are defined once in ./model.ts and re-exported here so existing
// `import { ... } from './folder'` call sites keep working.
export type { FileKind, FolderEntry, FolderScan, StageRow, UseCase, CatalogModel } from './model';

// Constants for folder reading caps
export const FOLDER_MAX_FILES = 200;
export const FOLDER_MAX_BYTES = 20 * 1024 * 1024; // 20 MB
/** Guard for the single-review picker: never fewer than the number of declared template references. */
export const FOLDER_MAX_TEMPLATES = 10;

// Helper to yield to the browser every so often
async function yieldToBrowser() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

// Function to read a folder from a FileList (from webkitdirectory input)
// Reads sequentially, applies caps, yields to browser every 25 files or 2 MB.
export async function readFolder(files: File[]): Promise<FolderScan> {
  let fileData: Array<{
    relativePath: string;
    name: string;
    text: string | undefined;
    parsed: unknown | undefined;
    byteLength: number;
    notes: string[];
  }> = [];

  let truncated = false;
  let fileCount = 0;
  let totalBytes = 0;
  const findings: Finding[] = [];

  for (const file of files) {
    // Check caps
    if (fileCount >= FOLDER_MAX_FILES) {
      findings.push({
        id: 'FOLDER_LIMIT',
        severity: 'Invalid' as const,
        category: 'Folder',
        artifact: 'local files',
        message: `Folder limit of ${FOLDER_MAX_FILES} files reached.`,
      });
      truncated = true;
      break;
    }
    if (totalBytes >= FOLDER_MAX_BYTES) {
      findings.push({
        id: 'FOLDER_LIMIT',
        severity: 'Invalid' as const,
        category: 'Folder',
        artifact: 'local files',
        message: `Folder byte limit of ${FOLDER_MAX_BYTES} bytes reached.`,
      });
      truncated = true;
      break;
    }

    try {
      const arrayBuffer = await file.arrayBuffer();
      const byteLength = arrayBuffer.byteLength;
      // Try to decode as UTF-8
      let text: string | undefined;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(arrayBuffer);
      } catch (e) {
        // UTF-8 decode failed
        fileData.push({
          relativePath: file.webkitRelativePath || file.name,
          name: file.name,
          text: undefined,
          parsed: undefined,
          byteLength,
          notes: [`Not verified — could not be decoded as UTF-8`],
        });
        fileCount++;
        totalBytes += byteLength;
        continue; // skip JSON parse
      }

      // Try to parse as JSON
      let parsed: unknown | undefined;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        // JSON parse failed
        fileData.push({
          relativePath: file.webkitRelativePath || file.name,
          name: file.name,
          text,
          parsed: undefined,
          byteLength,
          notes: [`Invalid JSON: ${e instanceof Error ? e.message : 'parse error'}`],
        });
        fileCount++;
        totalBytes += byteLength;
        continue;
      }

      // Successfully decoded and parsed
      fileData.push({
        relativePath: file.webkitRelativePath || file.name,
        name: file.name,
        text,
        parsed,
        byteLength,
        notes: [],
      });
      fileCount++;
      totalBytes += byteLength;
    } catch (e) {
      // arrayBuffer failed? (shouldn't happen)
      fileData.push({
        relativePath: file.webkitRelativePath || file.name,
        name: file.name,
        text: undefined,
        parsed: undefined,
        byteLength: 0,
        notes: [`Unable to read file: ${e instanceof Error ? e.message : 'unknown error'}`],
      });
      fileCount++;
      totalBytes += 0;
    }

    // Yield condition
    if (fileCount % 25 === 0 || totalBytes >= 2 * 1024 * 1024) {
      await yieldToBrowser();
    }
  }

  // Now we have fileData. We'll convert to FolderEntry placeholders.
  let entries: FolderEntry[] = fileData.map(fd => ({
    relativePath: fd.relativePath,
    name: fd.name,
    kind: 'unrecognised', // placeholder
    text: fd.text,
    parsed: fd.parsed,
    sourceArtifact: {
      name: fd.name,
      rawText: fd.text ?? '',
      parsed: fd.parsed,
      role: 'template', // placeholder
    },
    notes: fd.notes,
  }));

  // Now classify the entries (pure function)
  const classificationResult = classifyEntries(entries);
  // classificationResult.entries are the same entries but with kind and sourceArtifact.role set.
  // classificationResult.findings are any additional findings from classification.
  // We'll merge the findings.

  // Update the entries with the classified ones
  entries = classificationResult.entries;
  findings.push(...classificationResult.findings);

  // Deterministic ordering (D4/D8): the FileList order is implementation-defined, so sort by path.
  entries.sort((a, b) =>
    a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0
  );

  return {
    entries,
    findings,
    truncated,
    fileCount,
    totalBytes,
  };
}

// Pure function to classify entries (already read) into kinds.
// This function does not perform any I/O.
export function classifyEntries(entries: FolderEntry[]): FolderScan {
  const classified: FolderEntry[] = [];
  const findings: Finding[] = [];

  for (const entry of entries) {
    let newEntry = { ...entry };
    let kind: FileKind = 'unrecognised';

    let value = entry.parsed;

    if (value === undefined || value === null) {
      // Not a JSON object.
      // Check if it's an XML file by extension.
      if (entry.name.toLowerCase().endsWith('.xml')) {
        kind = 'raw-xml';
      } else {
        kind = 'unrecognised';
      }
    } else {
      // It is a JSON object (or at least we have something in parsed).
      if (isRegistration(value)) {
        kind = 'registration';
      } else if (isTemplate(value)) {
        kind = 'template';
      } else if (isSample(value)) {
        kind = 'sample';
      } else {
        kind = 'unrecognised';
      }
    }

    // Now set the kind and update the sourceArtifact.role accordingly.
    newEntry = {
      ...newEntry,
      kind,
      sourceArtifact: {
        ...newEntry.sourceArtifact,
        role: kind === 'registration' ? 'registration' :
              kind === 'template' ? 'template' :
              'template', // placeholder for sample, raw-xml, unrecognised
      },
    };

    classified.push(newEntry);
  }

  return {
    entries: classified,
    findings: [],
    truncated: false,
    fileCount: classified.length,
    totalBytes: 0,
  };
}

// Function to group duplicate entries by decoded text.
// Returns the canonical entries (one per group) and the duplicate entries.
// Also returns findings for duplicate groups.
export function groupDuplicates(entries: FolderEntry[]): {
  canonical: FolderEntry[];
  duplicates: FolderEntry[];
  findings: Finding[];
} {
  // Group by text (only entries with text)
  const groups = new Map<string, FolderEntry[]>();
  for (const entry of entries) {
    if (entry.text === undefined) continue;
    const group = groups.get(entry.text) ?? [];
    group.push(entry);
    groups.set(entry.text, group);
  }

  const canonical: FolderEntry[] = [];
  const duplicates: FolderEntry[] = [];
  const findings: Finding[] = [];

  for (const [text, groupEntries] of groups) {
    // Sort by relativePath lexicographically
    // N3: Prefer path without (n) suffix, then code-point order
    const dupeSuffix = /\([0-9]+\)(?=\.[^.]+$)/;
    const rank = (p: string) => dupeSuffix.test(p) ? 1 : 0;
    const sorted = [...groupEntries].sort((a, b) =>
      rank(a.relativePath) - rank(b.relativePath) ||
      (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0)
    );
    const canonicalEntry = sorted[0];
    canonical.push(canonicalEntry);
    // The rest are duplicates
    for (let i = 1; i < sorted.length; i++) {
      duplicates.push(sorted[i]);
    }
    // If there is more than one entry in the group, we have a duplicate group.
    if (sorted.length > 1) {
      const isTemplateGroup = canonicalEntry.kind === 'template';
      findings.push({
        id: isTemplateGroup ? 'DUPLICATE_TEMPLATE_FILE' : 'DUPLICATE_FILE',
        severity: 'Warning' as const,
        category: 'Folder',
        artifact: canonicalEntry.relativePath,
        message: `Duplicate ${isTemplateGroup ? 'template file' : 'file'} detected: ${canonicalEntry.relativePath} (and ${sorted.length - 1} other(s))`,
      });
    }
  }

  return {
    canonical,
    duplicates,
    findings,
  };
}

export function composeCatalog(scan: FolderScan): CatalogModel {
  // Step 0: If there are no entries, return empty.
  if (scan.entries.length === 0) {
    return {
      useCases: [],
      sideItems: [],
      findings: scan.findings,
      truncated: scan.truncated,
    };
  }

  // Step 1: Group duplicates to get canonical entries and duplicates.
  const { canonical, duplicates, findings: dupFindings } = groupDuplicates(scan.entries);

  // Step 2: Build a map from (id, type) to canonical entry for quick lookup.
  const canonicalMap = new Map<string, FolderEntry>();
  const idTypeToCanonical = new Map<string, FolderEntry[]>();

  for (const entry of canonical) {
    if (entry.kind === 'template' && entry.parsed !== undefined) {
      const value = entry.parsed as TemplateDefinition;
      const key = `${value.id}|${value.type}`;
      // Track all entries for this (id, type) for AMBIGUOUS_MATCH detection
      const arr = idTypeToCanonical.get(key) ?? [];
      arr.push(entry);
      idTypeToCanonical.set(key, arr);
      // For canonicalMap, we just keep the first (the canonical one after groupDuplicates sorting)
      if (!canonicalMap.has(key)) {
        canonicalMap.set(key, entry);
      }
    }
  }

  // Step 3: Process each registration entry to build use cases.
  const useCases: UseCase[] = [];
  const usedCanonicalSet = new Set<string>(); // relativePaths of canonical entries matched by at least one registration
  const claimCount = new Map<string, number>(); // relativePath -> number of registrations that matched it
  const allFindings: Finding[] = []; // every finding in the catalog (catalog-scoped + registration-scoped)
  const claimedByReg = new Map<string, Set<string>>(); // canonical relativePath -> set of registrationPaths

  // Reading-level findings belong to the folder as a whole, never to a single card.
  for (const f of scan.findings) {
    allFindings.push({ ...f, scope: 'catalog', registrationPath: undefined });
  }

  // All registrations in the folder.
  const registrationEntries = scan.entries.filter(
    e => e.kind === 'registration' && e.parsed !== undefined && isRegistration(e.parsed)
  );

  // File names the folder is expected to contain a template for (declared by any registration).
  // Used to tell "a declared template that will not decode" apart from unrelated junk in the folder,
  // so FILE_NOT_UTF8 is reported for the former without flagging every stray file.
  const expectedTemplateNames = new Set<string>();
  for (const regEntry of registrationEntries) {
    for (const instance of (regEntry.parsed as AdapterRegistration).templates) {
      expectedTemplateNames.add(`${instance.id}.json`);
      expectedTemplateNames.add(`${instance.id}.json`.split('/').pop()!);
    }
  }

  // An entry's template file is either present (canonical, matched in the loop below), present but
  // unreadable, or absent. Only "absent" is a missing template; the third state exists so a file that
  // is sitting right there is never reported as missing.
  const unreadableEntries = new Map<string, FolderEntry>();
  const entryStateFor = (instance: { id: string; type: string }): FolderEntry | undefined => {
    const canonicalEntry = canonicalMap.get(`${instance.id}|${instance.type}`);
    if (canonicalEntry) return canonicalEntry;
    const stem = `${instance.id}.json`.split('/').pop()!;
    const found = scan.entries.find(e =>
      e.kind !== 'registration' &&
      e.parsed === undefined &&
      (e.name === stem || e.name.startsWith(`${stem} (`))
    );
    if (found) unreadableEntries.set(found.relativePath, found);
    return found;
  };

  for (const regEntry of registrationEntries) {
    if (!regEntry.parsed) continue;
    // Parse the registration through the same pipeline the reviewer uses so the catalog-carded fields
    // (unknownFields, parameters, and structured template instances) are always present downstream.
    const regResult = parseRegistration(regEntry.parsed);
    const registration = regResult.registration;
    if (!registration) continue;
    const registrationPath = regEntry.relativePath;
    const regFindings = regResult.findings;

    // Build stages from registration.templates
    const stages: StageRow[] = [];
    const templatePathsSet = new Set<string>();
    const missing: Array<{ id: string; type: string }> = [];

    for (const instance of registration.templates) {
      const entry = entryStateFor(instance);
      const matched = entry !== undefined && entry.parsed !== undefined;
      if (matched) {
        // Track claim for this canonical entry
        const claimedSet = claimedByReg.get(entry!.relativePath) ?? new Set();
        claimedSet.add(registrationPath);
        claimedByReg.set(entry!.relativePath, claimedSet);
        usedCanonicalSet.add(entry!.relativePath);
        templatePathsSet.add(entry!.relativePath);
      } else {
        // Either absent, or present but unreadable (excluded from "missing" below).
        missing.push({ id: instance.id, type: instance.type });
      }
      stages.push({
        entryType: instance.type,
        entryId: instance.id,
        templateFilePath: matched ? entry!.relativePath : undefined,
        matched,
        processReference: processReferenceFor(instance),
      });
    }

    // Registration-scoped findings: the registration's own parse findings, plus the standing
    // static-only notice so every card carries it (it is not a defect of the folder).
    for (const f of regFindings) {
      allFindings.push({ ...f, scope: 'registration', registrationPath });
    }
    allFindings.push({
      id: 'RUNTIME_UNVERIFIED',
      severity: 'Not verified' as const,
      category: 'Runtime',
      artifact: regEntry.name,
      message: 'Catalog health describes static structure only. Runtime beans, Camel components, endpoint connectivity, route execution, and parameter precedence are not verified.',
      scope: 'registration',
      registrationPath,
    });

    useCases.push({
      registration,
      registrationPath,
      stages,
      templatePaths: Array.from(templatePathsSet),
      missing,
      extra: [], // will fill later
      duplicates: [], // will fill later
      health: 'Healthy', // will compute later
      findingGroups: [], // will compute later
      findings: regFindings, // replaced with the final per-card list below
    });
  }

  // TEMPLATE_SET_MISMATCH for genuinely absent templates only (registration-scoped: it is this
  // registration's entry that is unsatisfied, so it must never appear on another card).
  for (const useCase of useCases) {
    for (const m of useCase.missing) {
      if (unreadableEntries.has(`${m.id}.json`) || [...unreadableEntries.values()].some(e => e.name.startsWith(`${m.id}.json`.split('/').pop()!))) continue;
      allFindings.push({
        id: 'TEMPLATE_SET_MISMATCH',
        severity: 'Invalid' as const,
        category: 'Cross-artifact',
        artifact: useCase.registrationPath,
        message: `Missing template for declared entry: ${m.id} (${m.type})`,
        location: `$.templates[?(@.id=='${m.id}' && @.type=='${m.type}')]`,
        scope: 'registration',
        registrationPath: useCase.registrationPath,
      });
    }
  }

  // Duplicate groups (C3): these are catalog-level facts, so they belong in the catalog finding
  // list exactly once — not only in each card's group counts.
  for (const f of dupFindings) {
    allFindings.push({ ...f, scope: 'catalog', registrationPath: undefined });
  }

  // Emit AMBIGUOUS_MATCH for duplicate (id,type) among canonical files
  for (const [key, entries] of idTypeToCanonical) {
    if (entries.length > 1) {
      allFindings.push({
        id: 'AMBIGUOUS_MATCH',
        severity: 'Invalid' as const,
        category: 'Cross-artifact',
        artifact: entries.map(e => e.relativePath).join(', '),
        message: `Multiple template files share the same (id, type): ${key}`,
        location: entries.map(e => e.relativePath).join(', '),
        scope: 'catalog',
        registrationPath: undefined,
      });
    }
  }

  // Build claimCount from claimedByReg
  for (const [relPath, regPaths] of claimedByReg) {
    claimCount.set(relPath, regPaths.size);
  }

  // Find orphan templates: canonical entries not claimed by any registration
  const orphanPaths = new Set<string>();
  for (const entry of canonical) {
    if (entry.kind === 'template' && !claimedByReg.has(entry.relativePath)) {
      orphanPaths.add(entry.relativePath);
    }
  }

  // Emit ORPHAN_TEMPLATE findings (catalog-level)
  for (const orphanPath of orphanPaths) {
    allFindings.push({
      id: 'ORPHAN_TEMPLATE',
      severity: 'Warning' as const,
      category: 'Cross-artifact',
      artifact: orphanPath,
      message: `Template file not referenced by any registration: ${orphanPath}`,
      scope: 'catalog',
      registrationPath: undefined,
    });
  }

  // Emit TEMPLATE_SHARED findings (catalog-level)
  for (const [relPath, count] of claimCount) {
    if (count > 1) {
      allFindings.push({
        id: 'TEMPLATE_SHARED',
        severity: 'Warning' as const,
        category: 'Cross-artifact',
        artifact: relPath,
        message: `Template file shared by ${count} registrations: ${relPath}`,
        scope: 'catalog',
        registrationPath: undefined,
      });
    }
  }

  // C2 — present-but-unreadable files. The bug this replaces required `parsed !== undefined` while
  // trying to classify files that failed to parse, which made both branches below unreachable. This block
  // keys off the entry name instead, and distinguishes two audiences:
  //   * the file IS the declared template of an entry  -> registration-scoped (it blocks that entry)
  //   * nothing claims it                              -> catalog-scoped (it must not colour a card)
  for (const [relPath, entry] of unreadableEntries) {
    const hasUtf8Note = entry.notes.some(n => n.includes('could not be decoded as UTF-8'));
    const owningRegs = registrationEntries.filter(e =>
      (e.parsed as AdapterRegistration).templates.some(t => {
        const stem = `${t.id}.json`.split('/').pop()!;
        return entry.name === stem || entry.name.startsWith(`${stem} (`);
      })
    );
    const id = hasUtf8Note ? 'FILE_NOT_UTF8' : 'TEMPLATE_FILE_UNREADABLE';
    const message = hasUtf8Note
      ? `Template file ${relPath} is present but could not be decoded as UTF-8.`
      : `Template file ${relPath} is present but is not a readable template definition.`;

    if (owningRegs.length > 0) {
      for (const owner of owningRegs) {
        allFindings.push({
          id,
          severity: (hasUtf8Note ? 'Warning' : 'Invalid') as Finding['severity'],
          category: 'Import',
          artifact: relPath,
          message,
          location: relPath,
          scope: 'registration',
          registrationPath: owner.relativePath,
        });
      }
    } else {
      allFindings.push({
        id,
        severity: (hasUtf8Note ? 'Warning' : 'Invalid') as Finding['severity'],
        category: 'Import',
        artifact: relPath,
        message,
        location: relPath,
        scope: 'catalog',
        registrationPath: undefined,
      });
    }
  }

  // Undecodable files whose name matches a template the folder expects but which no entry resolved to:
  // reported once at catalog level, never charged to a card.
  for (const entry of scan.entries) {
    if (entry.parsed !== undefined) continue;
    if (unreadableEntries.has(entry.relativePath)) continue;
    if (!entry.notes.some(n => n.includes('could not be decoded as UTF-8'))) continue;
    if (!expectedTemplateNames.has(entry.name)) continue;
    allFindings.push({
      id: 'FILE_NOT_UTF8',
      severity: 'Warning' as const,
      category: 'Import',
      artifact: entry.relativePath,
      message: `File ${entry.relativePath} could not be decoded as UTF-8.`,
      location: entry.relativePath,
      scope: 'catalog',
      registrationPath: undefined,
    });
  }

  // Compute per-use-case health, findingGroups, extra, duplicates
  for (const useCase of useCases) {
    const regPath = useCase.registrationPath;

    // C1 — a card shows only findings it owns. Catalog-scoped findings (duplicates, orphans, shared
    // files, undecodable files nothing declares) are reported once at catalog level and are never
    // charged here, so one use case's problem can no longer appear as another use case's verdict.
    const regNames = new Set([regPath, useCase.registration.raw ? '' : ''].filter(Boolean));
    const relevantFindings = allFindings.filter(f =>
      f.scope !== 'catalog' &&
      f.registrationPath !== undefined &&
      (f.registrationPath === regPath || f.registrationPath === useCase.registrationPath)
    );

    // Health. The standing RUNTIME_UNVERIFIED notice is deliberately excluded from the chip: it is
    // present on every card by construction, so counting it would make every card read "Not verified"
    // and the chip would carry no information. This mirrors the reviewer's Validation tab, whose count
    // is invalid + warning only. A card is "Not verified" when the only thing wrong with it is that a
    // file could not be read.
    const chipFindings = relevantFindings.filter(f => f.id !== 'RUNTIME_UNVERIFIED');
    const hasInvalid = chipFindings.some(f => f.severity === 'Invalid');
    const hasWarning = chipFindings.some(f => f.severity === 'Warning');
    const hasNotVerified = chipFindings.some(f => f.severity === 'Not verified');
    let health: 'Healthy' | 'Warnings' | 'Errors' | 'Not verified';
    if (hasInvalid) health = 'Errors';
    else if (hasWarning) health = 'Warnings';
    else if (hasNotVerified) health = 'Not verified';
    else health = 'Healthy';

    // findingGroups
    const groupMap = new Map<string, { id: string; severity: Finding['severity']; count: number }>();
    for (const f of relevantFindings) {
      const existing = groupMap.get(f.id);
      if (existing) existing.count++;
      else groupMap.set(f.id, { id: f.id, severity: f.severity, count: 1 });
    }
    const findingGroups = Array.from(groupMap.values())
      .sort((a, b) => {
        const severityOrder = { 'Invalid': 0, 'Warning': 1, 'Not verified': 2, 'Valid': 3 };
        return (severityOrder[a.severity] ?? 99) - (severityOrder[b.severity] ?? 99);
      })
      .slice(0, 4);

    // Missing for this use case (already stored)
    const missing = useCase.missing;

    // Extra: orphan templates that THIS registration could have used
    const declaredTemplateIds = new Set(useCase.registration.templates.map(i => i.id));
    const extra = Array.from(orphanPaths).filter(p => {
      const canonicalEntry = canonical.find(e => e.relativePath === p);
      return canonicalEntry && declaredTemplateIds.has((canonicalEntry.parsed as TemplateDefinition)?.id);
    });

    // Duplicates: paths of duplicate files
    const duplicatePaths = duplicates.map(d => d.relativePath);

    // Update use case
    const uc = useCases.find(u => u.registrationPath === useCase.registrationPath);
    if (uc) {
      uc.health = health;
      uc.findingGroups = findingGroups;
      uc.findings = relevantFindings;
      uc.extra = extra;
      uc.duplicates = duplicatePaths;
      uc.templatePaths = useCase.templatePaths; // already set
    }
  }

  // Step 5: Build sideItems
  const sideItems: FolderEntry[] = scan.entries.filter(e => {
    if (usedCanonicalSet.has(e.relativePath)) return false;
    return e.kind === 'sample' || e.kind === 'raw-xml' || e.kind === 'unrecognised' ||
           duplicates.some(d => d.relativePath === e.relativePath);
  });

  return {
    useCases,
    sideItems,
    findings: allFindings,
    truncated: scan.truncated,
  };
}

// Predicates for classification
export function isTemplate(value: unknown): boolean {
  const v = value as Record<string, unknown>;
  return !!v && typeof v.id === 'string' && typeof v.xmlRoute === 'string' && Array.isArray(v.inputParameters) && !Array.isArray(v.templates);
}

export function isRegistration(value: unknown): boolean {
  const v = value as Record<string, unknown>;
  return !!v && typeof v.type === 'string' && typeof v.name === 'string' && Array.isArray(v.templates);
}

export function isSample(value: unknown): boolean {
  const v = value as Record<string, unknown>;
  return !!v && (typeof v.eventId === 'string' || typeof v.eventType === 'string');
}