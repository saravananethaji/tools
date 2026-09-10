# Project Specification: Maven Dependency Graph (`projectgraph`)

> This file records the original feature specification. Current product
> boundaries and correctness rules are in `DESIGN.md`; the only prioritized
> backlog is `TODO.md`. Where wording conflicts, those two files win.

> **Comprehensive Technical Specification: Requirements, Architecture, Logic Implemented, and Test Verification Matrix**

---

## 1. Project Overview

`projectgraph` is a full-stack Python (FastAPI) and modern browser-based web application designed for analyzing, visualizing, and auditing multi-project Java/Maven codebases. It solves common enterprise Maven challenges:
- Resolving complex transitive dependency hierarchies.
- Detecting version conflicts across disjoint services and shared libraries.
- Classifying Maven projects into architectural roles (BOMs, Frameworks, Services, Packaging, Plugins).
- Exporting graph topologies to Neo4j Cypher and JSON for graph database querying and security audits.
- Locating exact artifact coordinates and showing parent-chain context without
  claiming vulnerability discovery or an automatic remediation.

---

## 2. Requirements Specification

### 2.1 Functional Requirements (FR)

| ID | Feature | Description |
| :--- | :--- | :--- |
| **FR-1** | **Recursive POM Discovery** | Scan an allowed root directory recursively to discover all `pom.xml` files while ignoring build directories (e.g., `target/`). |
| **FR-2** | **Transitive Dependency Tree** | Run `mvn dependency:tree -DoutputType=dot` to extract complete dependency trees including all transitive levels, scopes (`compile`, `test`, `provided`, `runtime`, `import`), and classifiers. |
| **FR-3** | **Zero-Dependency Graceful Handling** | Support aggregator POMs, parent BOMs, and standalone modules with zero declared dependencies without failing or raising false errors. |
| **FR-4** | **Global Version Conflict Detection** | Aggregate all occurrences of `groupId:artifactId` across all projects and identify coordinates resolving to multiple distinct versions. |
| **FR-5** | **Interactive Web UI & Tree Navigation** | Provide an interactive single-page interface with collapsible module cards, tree node expansion, match highlighting, and synchronized expand/collapse controls. |
| **FR-6** | **Search & Real-Time Filtering** | Search box on the tree page allowing substring filtering against `groupId`, `artifactId`, or `version`. Matching nodes are highlighted in accent colors while non-matching nodes are dimmed. |
| **FR-7** | **Neo4j Cypher Export** | Export the unified dependency graph as `.cypher` statements using idempotent `MERGE` queries (`:Artifact` nodes and `:DEPENDS_ON` relationships). |
| **FR-8** | **JSON State Export & Ingestion** | Offline extraction CLI (`maven_extractor.py`) producing rich JSON snapshots, paired with a web API (`/api/load-json`) to visualize graphs without requiring a live Maven/Java environment. |
| **FR-9** | **Artifact and Parent-Chain Tracing** | Locate exact coordinates and show parent POM context. Do not infer a safe upgrade or vulnerability status without resolved paths and advisory evidence. |
| **FR-10** | **Dynamic Directory Switching** | Directory-path input in the web navigation bar allowing re-scanning of directories configured under `PROJECTGRAPH_ALLOWED_ROOTS` via `POST /api/load`. |

---

### 2.2 Non-Functional Requirements (NFR)

* **NFR-1 (Non-Blocking Concurrency)**: Heavy subprocess calls (`mvn dependency:tree`) and disk walks must execute in Starlette threadpools (`run_in_threadpool`) so the FastAPI event loop remains responsive.
* **NFR-2 (Deterministic Caching)**: Disk cache keys are path-based, while compatibility requires the cache schema, Maven command/version, age, POM/configuration content fingerprint, and Maven settings fingerprint to match. Explicit reload always bypasses cache.
* **NFR-3 (Recursion Safety & Cycle Breaking)**: Graph and POM classification logic must be provably acyclic-safe through visited tracking and memoization.
* **NFR-4 (Security & Path Sanitization)**: `/api/load` accepts only normalized absolute directories inside `PROJECTGRAPH_ALLOWED_ROOTS` (path-separator-delimited; defaults to the application directory). Symlinks are resolved before the boundary check. Subprocess execution in `maven_runner.py` must avoid `shell=True`.
* **NFR-5 (Modern Visual Ergonomics)**: High-contrast dark theme (`#0f1117`), fluid responsive typography, badge indicators for scopes and conflicts, and smooth CSS transitions.

---

## 3. Architecture & Logic Implemented

### 3.1 Module Directory Structure

```text
projectgraph/
├── app.py                     # FastAPI routes, exception handlers, JSON loader, state management
├── pom_parser.py              # Shared POM XML parser, classifier heuristics, coordinate parsing
├── maven_runner.py            # Subprocess mvn exec, DOT graph parsing, disk cache orchestration
├── graph_model.py             # Domain models (GraphModel, Module, TreeNode, Conflict)
├── neo4j_export.py            # Cypher script generation (MERGE :Artifact, MERGE :DEPENDS_ON)
├── maven_extractor.py         # Standalone static extractor and artifact locator
├── trace_ancestors.py         # Ancestral POM parent chain tracer for transitive dependencies
├── templates/                 # Jinja2 HTML templates
│   ├── base.html              # Shell layout, theme styles, live folder loader
│   ├── tree.html              # Collapsible dependency tree viewer, search highlighting
│   ├── conflicts.html         # Multi-version conflict table and occurrence details
│   └── export.html            # Cypher viewer with clipboard copy and download
├── cache/                     # SHA-256 hashed JSON cache for fast reload
├── test_projects/             # Embedded multi-module Maven fixture projects for testing
│   ├── bom/                   # internal-parent-bom, service-bom
│   ├── framework/             # service-framework
│   ├── services/              # order-service, payment-service, inventory-service
│   ├── packaging/             # service-packaging
│   └── common/                # common-utils
└── test_projects/__e2e__/     # Playwright UI end-to-end test suite
    └── ui_tests.spec.js       # 6 automated E2E test specs
```

---

### 3.2 Core Component Logic

#### A. Web Routing & API Layer (`app.py`)
- `GET /` $\to$ Redirects to `/tree`.
- `GET /tree` $\to$ Renders `tree.html` populated with current modules and pre-rendered query state.
- `GET /conflicts` $\to$ Calculates version collisions via `GraphModel.conflicts()` and renders `conflicts.html`.
- `GET /export` & `GET /export/download` $\to$ Generates Cypher queries for Neo4j import or raw `.cypher` download.
- `GET /api/state` $\to$ Returns full JSON representation of all modules and dependency trees.
- `POST /api/load` $\to$ Validates input path using `_validate_root_path()`, scans directory, builds model asynchronously, and updates memory state.
- `POST /api/reload` $\to$ Forces cache bypass and re-executes `mvn dependency:tree`.
- `POST /api/load-json` $\to$ Ingests offline JSON export from `maven_extractor.py` without requiring Maven installed.

#### B. POM Parsing & Classification Engine (`pom_parser.py`)
Parses `pom.xml` using `xml.etree.ElementTree` without XML namespace prefixes (handling `xmlns="http://maven.apache.org/POM/4.0.0"` via wildcard stripping).

**Classification Rules Matrix (`ProjectClassifier`):**
1. `packaging="pom"`, has `dependencyManagement`, no `<modules>`:
   - If imported by other POMs $\to$ **Service BOM**
   - Otherwise $\to$ **Internal Parent BOM**
2. `packaging="pom"`, has `<modules>`, imports a BOM $\to$ **Service Framework**
3. `packaging="pom"`, has `<modules>`, parent is `Service Framework` $\to$ **Service Project**
4. `packaging in ("jar", "war")`, parent is `Service Project` $\to$ **Service Code**
5. `packaging="pom"`, uses packaging plugin $\to$ **Service Packaging**
6. `packaging in ("pom", "jar")`, parent is `Service Packaging` $\to$ **Service Package**
7. `packaging="maven-plugin"` $\to$ **Package Gen**
8. `packaging="jar"`, parent is a BOM, used by $\ge 3$ services $\to$ **Common Component**

> **Recursion Safety Guard**: All classification checks pass `_memo: Dict` and `_visiting: Set`. Cyclic or self-referential parent/usage checks instantly short-circuit with `("Other Module", "cycle detected")`.

#### C. Maven DOT Execution & Tree Rebuilder (`maven_runner.py`)
1. Executes `mvn --non-recursive dependency:tree -DoutputType=dot -DoutputFile=<tmp_file> -q` inside each POM directory.
2. Parses DOT output using regex:
   - Matches digraph header: `digraph "groupId:artifactId:type:version" {` to identify root.
   - Matches directed edges: `"src" -> "dst"`.
3. Coordinates preserve `groupId`, `artifactId`, packaging, optional classifier, version, and scope. Graph identity includes packaging and classifier so variants cannot collapse into one artifact.
4. Rebuilds every dependency path recursively. Cycle detection tracks only the current ancestor path, so a shared dependency reached through two parents remains present under both parents.
5. If a module has zero dependencies (only digraph header and closing bracket), creates a root `TreeNode` with empty children instead of failing.

#### D. Conflict Analysis (`graph_model.py`)
1. Iterates over all modules and recursively traverses every `TreeNode`.
2. Maps `groupId:artifactId` $\to$ `{version: Set[occurrence_locations]}`.
3. Filters for coordinates where `len(distinct_versions) > 1`.
4. Emits `Conflict` objects showing the colliding versions and exact module paths where each appears.

#### E. Neo4j Cypher Generator (`neo4j_export.py`)
Generates standardized, reproducible Cypher statements:
```cypher
MERGE (a:Artifact {id: "com.company:order-service:jar:1.5.0", groupId: "com.company", artifactId: "order-service", version: "1.5.0"})
MERGE (b:Artifact {id: "org.springframework:spring-core:jar:6.1.1", groupId: "org.springframework", artifactId: "spring-core", version: "6.1.1"})
MERGE (a)-[:DEPENDS_ON {scope: "compile"}]->(b);
```

---

## 4. Test Verification Matrix

Automated testing is implemented with Playwright in `test_projects/__e2e__/ui_tests.spec.js`. The results below were verified locally on 2026-09-09.

### 4.1 Test Suites Summary

| Test Case | Objective | Test Verification Steps | Result |
| :--- | :--- | :--- | :---: |
| **Test 1: Page Title and Load** | Verify initial routing and HTML page structure. | Navigates to `http://127.0.0.1:8000/`, waits for `networkidle`, checks title matches `/Dependency Hierarchy/`. | ✅ **PASS** |
| **Test 2: Tree View Module Loading** | Verify that modules in `test_projects` are discovered and rendered. | Navigates to `/tree`, verifies `.module-card` count is greater than 0 (verifies 11 cards found). | ✅ **PASS** |
| **Test 3: Search Functionality** | Validate live client-side filtering and visual highlighting. | Enters `'order-service'` in `#search`, waits 1000ms, verifies `.node.match` elements $> 0$, clears search. | ✅ **PASS** |
| **Test 4: Version Indicators Display** | Verify module version and architectural classification badges. | Requires exactly 11 module version badges and at least one classification badge per module. | ✅ **PASS** |
| **Test 5: Collapse / Expand All** | Validate batch tree visibility controls. | Clicks `Collapse All`, verifies `.tree-body` elements contain `.hidden` class; clicks `Expand All`, verifies `.hidden` removed. | ✅ **PASS** |
| **Test 6: Navigation Links** | Verify end-to-end user journey across all three main views. | Clicks nav link `1 · Dependency Tree` $\to$ verifies `.module-card`; clicks `2 · Conflicts` $\to$ verifies `.module-card`; clicks `3 · Neo4j Export` $\to$ verifies `pre.export`. | ✅ **PASS** |

---

### 4.2 Edge Cases Handled & Tested

1. **Missing Default Fixture Path**:
   - *Problem*: Previously defaulted to `../test` which failed in fresh clones.
   - *Fix*: Detects `test_projects` in current workspace before falling back.
2. **Infinite Recursion in Classification**:
   - *Problem*: `ProjectClassifier` crashed with `RecursionError` on mutual dependencies.
   - *Fix*: Integrated memoization (`_memo`) and stack tracking (`_visiting`).
3. **Zero-Dependency Module DOT Output**:
   - *Problem*: Modules with no dependencies returned empty edge lists and raised `"Root module not found"`.
   - *Fix*: Extracted root node metadata from `digraph "..."` header.
4. **Relative Path Resolution in Nested Maven POMs**:
   - *Problem*: Relative parent paths (`<relativePath>`) were misconfigured by one directory level in test POMs.
   - *Fix*: Standardized parent paths (`../../framework/...`, `../../bom/...`, `../order-service`).
5. **Class Selection on Conflict View**:
   - *Problem*: Test selector `.err-box, .module-card` failed on `/conflicts` because cards only had class `.card`.
   - *Fix*: Added `.module-card` to conflict cards so navigation assertions pass consistently.

---

---

## 5. Comprehensive Usage Guide

### 5.1 Environment Setup & Installation

#### Prerequisites
- **Python**: 3.9 or higher (tested with 3.11)
- **Apache Maven**: 3.6+ on `PATH` (`mvn -v`)
- **Node.js**: 18+ (required for Playwright E2E test runner)

#### Installation
```bash
# 1. Clone repository and navigate to root
cd projectgraph

# 2. Create and activate Python virtual environment
python3 -m venv .venv
source .venv/bin/activate

# 3. Install Python dependencies
pip install -r requirements.txt

# 4. Install Playwright test dependencies
npm install
npx playwright install chromium
```

---

### 5.2 Web Application Usage

#### 1. Starting the Development Server
```bash
# Activate environment
source .venv/bin/activate

# Launch FastAPI with live reload
export PROJECTGRAPH_ALLOWED_ROOTS="/Users/username/git"
python -m uvicorn app:app --host 127.0.0.1 --port 8000 --reload
```
Open your browser to: **`http://127.0.0.1:8000`** (automatically redirects to `/tree`).

#### 2. Loading a Project Directory
* **Allowed roots**: Set `PROJECTGRAPH_ALLOWED_ROOTS` before startup. Separate multiple roots with the operating system path separator (`:` on macOS/Linux). The default permits only the application directory.
* **Via Web UI**:
  - Enter the absolute folder path into the header input (e.g. `/Users/username/git/my-java-projects`).
  - Click **Load folder**. The UI displays `loading…`, then `✓ N modules loaded`, and refreshes automatically.
* **Via cURL / API**:
  ```bash
  curl -X POST -d "root=/Users/username/git/my-java-projects" http://127.0.0.1:8000/api/load
  ```
* **Default Directory**:
  If no root is submitted, the application defaults to the embedded `test_projects/` directory.

#### 3. Exploring the Dependency Tree (`/tree`)
- **Expand / Collapse Modules**: Click on any module header card (caret `▶` / `▼`) to expand its dependency tree.
- **Batch Controls**: Use the **Collapse All** and **Expand All** buttons in the toolbar to toggle all modules at once.
- **Search & Filter**: Type into the search box (`Search modules/dependencies…`):
  - Typing `spring` or `order-service` will immediately highlight matching nodes in bright blue (`.node.match`) and dim non-matching nodes (`.node.dim`).
  - A counter displays the number of matching artifacts (e.g. `2 matches`).
- **Badge Legend**:
  - `compile`, `test`, `provided`, `runtime`: Maven dependency scopes.
  - `error`: Subprocess or POM building error, clicking displays full `mvn` stderr.
  - `↕`: Direct POM version override of a BOM-managed version.
  - `🟡`: Version range explicitly extended.
  - `🔄`: Duplicate JAR detected across multiple modules.

#### 4. Analyzing Conflicts (`/conflicts`)
- Click **2 · Conflicts** in the top navigation bar.
- Shows all `groupId:artifactId` dependencies that resolve to multiple conflicting versions across projects.
- Displays:
  - Colliding versions (in pink badges, e.g. `1.2.0`, `1.5.0`).
  - Occurrence breakdown table showing which module brings in each version, with its scope and exact coordinate.

#### 5. Exporting to Neo4j Graph Database (`/export`)
- Click **3 · Neo4j Export** in the top navigation bar.
- Generates Cypher `MERGE` statements creating `:Artifact` nodes and `:DEPENDS_ON` relationships with scopes.
- **Copy**: Click **📋 Copy to clipboard** to paste directly into Neo4j Browser.
- **Download**: Click **⬇ Download .cypher** or query `GET /export/download` to obtain the script file.
- **Ingest into Neo4j**:
  ```bash
  cypher-shell -u neo4j -p password -f dependency-graph.cypher
  ```

#### 6. Ingesting Offline JSON Snapshots (`/api/load-json`)
To view dependency graphs on machines without Java/Maven installed, upload a pre-generated JSON export from `maven_extractor.py`:
```bash
curl -X POST -F "file=@analysis.json" http://127.0.0.1:8000/api/load-json
```

---

### 5.3 Command-Line Interface (CLI) Utilities

#### A. Headless Analysis & Export (`maven_extractor.py`)
Generates comprehensive offline reports and machine-readable JSON schemas:
```bash
# Generate Markdown analysis report
python maven_extractor.py /path/to/java/projects -o report.md

# Generate structured JSON for ProjectGraph ingestion
python maven_extractor.py /path/to/java/projects -o analysis.json -f json

# Generate both Markdown and JSON simultaneously
python maven_extractor.py /path/to/java/projects -o output_base -f both
```

**CLI Parameters:**
- `<root_directory>`: Path to scan for POM files (required).
- `-o, --output`: Destination output file path or base name (default: `maven_analysis.md`).
- `-f, --format`: Output format: `markdown`, `json`, or `both` (default: `markdown`).
- `-v, --verbose`: Enable verbose logging during scanning.

#### B. Artifact and Parent-Chain Tracing (`trace_ancestors.py`)
Shows static parent-chain context for an exact artifact. It does not discover
vulnerabilities or determine a safe remediation:
```bash
python trace_ancestors.py -i analysis.json --artifact org.yaml:snakeyaml:1.33
```

**Output provided:**
- Total occurrences, split by direct vs. transitive.
- Complete parent inheritance POM chain (file paths and coordinates).
- An explicit warning that static evidence cannot establish a safe version change.

---

### 5.4 REST API Reference

| Endpoint | Method | Params / Body | Description |
| :--- | :--- | :--- | :--- |
| `/tree` | `GET` | `q` (optional filter query) | Returns HTML dependency tree page. |
| `/conflicts` | `GET` | None | Returns HTML version collision analysis page. |
| `/export` | `GET` | None | Returns HTML Cypher preview page. |
| `/export/download` | `GET` | None | Downloads raw `.cypher` file (`application/octet-stream`). |
| `/api/state` | `GET` | None | Returns full graph state as JSON (`modules`, `trees`, `errors`). |
| `/api/load` | `POST` | `root: str` (form-urlencoded) | Scans new directory and rebuilds model. |
| `/api/reload` | `POST` | None | Bypasses disk cache and forces fresh `mvn` execution. |
| `/api/load-json` | `POST` | `file: UploadFile` (multipart) | Ingests offline JSON export from `maven_extractor.py`. |

---

## 6. Verification & Automated Testing

### 6.1 Running E2E Test Suite
The complete regression command runs unit tests, starts the application on an
available local port, waits for an explicit render-complete marker, runs the
browser suite, and shuts the test server down:

```bash
npm test
```

### 6.2 Python Code Health & Compilation Check
```bash
python -m py_compile app.py maven_runner.py graph_model.py pom_parser.py neo4j_export.py maven_extractor.py trace_ancestors.py
```

### 6.3 Core Regression Tests

```bash
python -m unittest discover -s tests -v
```
