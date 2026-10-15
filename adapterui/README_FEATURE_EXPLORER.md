# Feature File Explorer Tool

## Overview
This tool analyzes Gherkin/Cucumber .feature files to explain their execution flow, dependencies, API calls, and artifacts used. It transforms specification documents into actionable insights for test impact analysis, dependency management, and API contract verification.

## Files Included

### Documentation
- `FEATURE_FILE_EXPLORER_REQUIREMENTS.md` - Requirements specification
- `FEATURE_FILE_EXPLORER_PLAN.md` - Implementation roadmap
- `FEATURE_FILE_EXPLORER_SUMMARY.md` - Technical overview
- `FEATURE_FILE_EXPLORER_COMPLETION_SUMMARY.md` - Completion summary
- `README_FEATURE_EXPLORER.md` - This file

### Implementation
- `src/components/FeatureFileExplorer.js` - React component
- `src/components/FeatureFileExplorer.css` - Component styling
- `test-feature-content.feature` - Sample feature file
- `feature-explorer-demo.html` - Standalone demo

## How to Use

### Option 1: Standalone Demo (Recommended for Quick Testing)
1. Open `feature-explorer-demo.html` in any modern browser
2. Click "Load Sample Feature File" to see the example content
3. Click "Analyze Feature" to see the automated analysis
4. Use "Generate Explanation" for human-readable narrative
5. Upload your own .feature files using the file input

### Option 2: Integrated into Existing Project
1. Copy `src/components/FeatureFileExplorer.js` and `src/components/FeatureFileExplorer.css` to your React project
2. Import and use the `<FeatureFileExplorer />` component
3. Ensure React 16.8+ is available (for hooks)
4. Optional: Add to routes or toolbars as needed

## Features Implemented

### File Processing
- Reads .feature files via browser File API
- Handles UTF-8 encoded feature files
- Basic syntax validation

### Gherkin Parsing
- Parses Feature declarations
- Extracts Background sections
- Identifies Scenarios and Scenario Outlines
- Processes Given/When/Then/And/But steps
- Handles multiline strings and data tables

### Semantic Analysis
- **API Call Detection**: Identifies HTTP methods (POST, GET, PUT, DELETE) and extracts endpoint URIs
- **Header Analysis**: Extracts UUID headers for request tracing, identifies Content-Type, Authorization headers
- **File Reference Tracking**: Locates JSON payload file references, identifies configuration file dependencies
- **Database Validation Recognition**: Identifies db table validation patterns, extracts TestCaseID/ColumnName/Operator/DataType/ColumnValue, parses record count expectations
- **Dependency Detection**: Parses explicit dependency comments ("requires Scenario X"), identifies implicit dependencies through shared data
- **Artifact Cataloging**: Builds inventory of all referenced files, tracks UUIDs, file paths, database tables, documents external service references

### User Interface
- Clean, intuitive file upload interface
- Real-time parsing with loading states
- Error handling for invalid/malformed files
- Collapsible analysis sections for readability
- Copy-friendly formatted output
- Responsive design (works on mobile/desktop)
- Human-readable explanation generation

## Sample Analysis Results

When tested with the provided feature file, the tool correctly identified:

### API Calls
- POST `/system/adapters/templates/direct:ApiToApi`
- POST `/system/adapters/generic.Routeid`  
- POST `/system/apitoapijobs/ApiToApi` (success/failure cases)

### Artifacts Detected
- UUIDs: `adapqi-da5244e-a140-470e-83ad-768cb225640`, `adapqn-da5244e-a140-470e-83ad-768cb225640`
- Request bodies: Multiple JSON payload files
- Database tables: `adapter_context`, `ms_inbox_events`
- File references: All src/test/resources paths
- External endpoints: http://dummyip:3000/... (failure case)

### Dependencies
- Explicit: "Scenario 3 requires Scenario 1 and 2"
- Implicit: Template → Adapter → Validation flow

### Data Validations
- adapter_context table checks for invoice/test values
- ms_inbox_events status validation (PROCESSED)

## Extensibility

The implementation is designed for easy extension:
- **Advanced Visualizations**: Dependency graphs using Mermaid.js (planned)
- **Export Capabilities**: JSON, Markdown, HTML reports (planned)
- **Enhanced UI**: Drag-and-drop, search/filter (planned)
- **Performance Optimization**: Caching, incremental parsing (planned)
- **Custom Pattern Matchers**: Add new step pattern recognizers
- **Validation Engines**: Plug-in custom business rule validators
- **Integration Adapters**: Connect to actual test execution results

## Validation

The implementation has been validated with:
- The original base64-decoded feature file content
- Various edge cases (empty files, malformed syntax)
- Different Gherkin constructs (Scenario Outlines, Examples tables)
- Multiple API call patterns and header formats
- Complex data validation scenarios

## Usage Instructions

### For End Users
1. Open the feature-explorer-demo.html in any modern browser
2. Click "Load Sample Feature File" to see example content
3. Click "Analyze Feature" to see the automated analysis
4. Use "Generate Explanation" for human-readable narrative
5. Upload your own .feature files using the file input

### For Developers
1. Copy `src/components/FeatureFileExplorer.js` and `.css` to your React project
2. Import and use the `<FeatureFileExplorer />` component
3. Ensure React 16.8+ is available (for hooks)
4. Optional: Add to routes or toolbars as needed

## Support

For questions or issues, please refer to the documentation files included in this package.