import React from 'react';

type DiscoveredFeature = {
  name: string;
  fileName: string;
  relativePath: string;
  scenarioCount: number;
  backgroundSteps: number;
  tagsList: string[];
  rawText: string;
};

export const DiscoveryModeUI: React.FC<{
  discoveredFeatures: DiscoveredFeature[];
  discoveryError: string | null;
  selectedFeature: DiscoveredFeature | null;
  templateFolderSelected: boolean;
  onParentFolderSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onTemplateFolderSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onSelectFeature: (f: DiscoveredFeature) => void;
  onBackToDiscovery: () => void;
}> = ({
  discoveredFeatures,
  discoveryError,
  selectedFeature,
  templateFolderSelected,
  onParentFolderSelect,
  onTemplateFolderSelect,
  onSelectFeature,
  onBackToDiscovery,
}) => {
  const featuresFound = discoveredFeatures.length > 0;

  return (
    <div style={{ padding: '24px', maxWidth: '1200px', margin: '0 auto' }}>
      <div style={{ background: '#172230', border: '1px solid #3a536f', borderRadius: '12px', padding: '24px', marginBottom: '24px' }}>
        <h2 style={{ fontSize: '1.6rem', marginBottom: '8px', color: '#e9edf5' }}>🔍 Feature Discovery — Browse Folder</h2>
        <p style={{ color: '#94a3b8', fontSize: '0.9rem', marginBottom: '16px' }}>
          {selectedFeature ? 'A feature is selected. Explore it below or go back.' : ''}
          {!selectedFeature && !featuresFound
            ? 'Step 1: Select the folder containing your .feature files.'
            : !selectedFeature && featuresFound && !templateFolderSelected
              ? 'Step 2: Select the base folder containing your test data files (payloads, adapter configs, events). All subfolders are scanned recursively.'
              : !selectedFeature && featuresFound && templateFolderSelected
                ? 'Both folders selected. Click a feature to inspect it.'
                : ''}
        </p>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
          {!selectedFeature && !featuresFound && (
            <>
              <input
                type="file"
                {...({ webkitdirectory: '' } as Record<string, string>)}
                style={{ display: 'none' }}
                id="discovery-folder-input"
                onChange={onParentFolderSelect}
              />
              <label htmlFor="discovery-folder-input" style={{ cursor: 'pointer', padding: '10px 20px', background: '#2563eb', color: '#fff', borderRadius: '8px', fontWeight: 600, border: 'none' }}>
                📂 Select Feature Folder
              </label>
            </>
          )}

          {!selectedFeature && featuresFound && !templateFolderSelected && (
            <>
              <input
                type="file"
                {...({ webkitdirectory: '' } as Record<string, string>)}
                style={{ display: 'none' }}
                id="discovery-template-folder-input"
                onChange={onTemplateFolderSelect}
              />
              <label htmlFor="discovery-template-folder-input" style={{ cursor: 'pointer', padding: '10px 20px', background: '#0ea5e9', color: '#fff', borderRadius: '8px', fontWeight: 600, border: 'none' }}>
                📁 Select Base Test Data Folder
              </label>
            </>
          )}

          {!selectedFeature && featuresFound && templateFolderSelected && (
            <span style={{ color: '#22c55e', fontWeight: 600, fontSize: '0.9rem' }}>
              ✅ Both folders selected — ready to explore features
            </span>
          )}

          {selectedFeature && (
            <button
              style={{ padding: '10px 16px', background: '#334155', color: '#e9edf5', border: '1px solid #475569', borderRadius: '8px', cursor: 'pointer' }}
              onClick={onBackToDiscovery}
            >
              ← Back to List
            </button>
          )}
        </div>
      </div>

      {discoveryError && (
        <div style={{ padding: '12px', background: '#3b1c1c', border: '1px solid #ef4444', borderRadius: '8px', color: '#fca5a5', marginBottom: '16px' }}>
          <strong>Notice:</strong> <span>{discoveryError}</span>
        </div>
      )}

      {featuresFound && !selectedFeature ? (
        <div>
          <h3>Features Found ({discoveredFeatures.length})</h3>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem', color: '#e2e8f0' }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '2px solid #34445d' }}>
                <th>Feature</th>
                <th>Path</th>
                <th>Scenarios</th>
                <th>Tags</th>
                <th>Background Steps</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {discoveredFeatures.map((f, idx) => (
                <tr key={idx} style={{ borderBottom: '1px solid #34445d' }}>
                  <td style={{ padding: '10px' }}>{f.name}</td>
                  <td style={{ padding: '10px', fontSize: '0.8rem', color: '#94a3b8', fontFamily: 'monospace' }}>{f.relativePath}</td>
                  <td style={{ padding: '10px', textAlign: 'center' }}>{f.scenarioCount}</td>
                  <td style={{ padding: '10px' }}>{f.tagsList.join(', ') || '—'}</td>
                  <td style={{ padding: '10px', textAlign: 'center' }}>{f.backgroundSteps}</td>
                  <td style={{ padding: '10px' }}>
                    <button
                      style={{ padding: '6px 12px', background: '#0ea5e9', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '0.8rem' }}
                      onClick={() => onSelectFeature(f)}
                    >
                      Explore
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {!discoveryError && !featuresFound && !selectedFeature && (
        <div className="empty" style={{ padding: '60px 30px', textAlign: 'center', borderRadius: '12px', border: '1px dashed #3a4c65', marginTop: '20px' }}>
          <h3>Select a feature folder to begin</h3>
          <p className="muted">Choose a parent folder containing .feature files to discover available features.</p>
        </div>
      )}
    </div>
  );
};
