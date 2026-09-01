import re
from typing import Dict, List, Optional, Tuple
from neo4j import GraphDatabase

# =====================================================================
# 1. MAVEN COORDINATE PARSER
# =====================================================================

def parse_maven_coordinate(coord_str: str) -> Dict[str, str]:
    """
    Parses standard Maven artifact strings:
    - groupId:artifactId:packaging:version:scope
    - groupId:artifactId:packaging:classifier:version:scope
    - groupId:artifactId:packaging:version
    """
    cleaned = coord_str.strip().strip('"').strip("'")
    parts = cleaned.split(":")
    
    if len(parts) == 5:
        # Standard: groupId:artifactId:type:version:scope
        return {
            "id": f"{parts[0]}:{parts[1]}:{parts[3]}",
            "groupId": parts[0],
            "artifactId": parts[1],
            "packaging": parts[2],
            "version": parts[3],
            "scope": parts[4]
        }
    elif len(parts) == 6:
        # With classifier: groupId:artifactId:type:classifier:version:scope
        return {
            "id": f"{parts[0]}:{parts[1]}:{parts[4]}",
            "groupId": parts[0],
            "artifactId": parts[1],
            "packaging": parts[2],
            "classifier": parts[3],
            "version": parts[4],
            "scope": parts[5]
        }
    elif len(parts) == 4:
        # Root module / no scope: groupId:artifactId:type:version
        return {
            "id": f"{parts[0]}:{parts[1]}:{parts[3]}",
            "groupId": parts[0],
            "artifactId": parts[1],
            "packaging": parts[2],
            "version": parts[3],
            "scope": "compile"
        }
    else:
        # Fallback for non-standard definitions
        return {
            "id": cleaned,
            "groupId": parts[0] if len(parts) > 0 else "unknown",
            "artifactId": parts[1] if len(parts) > 1 else cleaned,
            "packaging": "jar",
            "version": parts[-1] if len(parts) > 2 else "unknown",
            "scope": "compile"
        }


def parse_dot_file(filepath: str) -> Tuple[List[Dict], List[Dict]]:
    """
    Extracts nodes and dependency edges from a Maven DOT file.
    """
    edge_pattern = re.compile(r'"([^"]+)"\s*->\s*"([^"]+)"')
    
    artifacts: Dict[str, Dict] = {}
    dependencies: List[Dict] = []

    with open(filepath, "r", encoding="utf-8") as f:
        for line in f:
            match = edge_pattern.search(line)
            if match:
                src_raw, dst_raw = match.group(1), match.group(2)
                
                src_data = parse_maven_coordinate(src_raw)
                dst_data = parse_maven_coordinate(dst_raw)
                
                # Store unique artifact nodes
                artifacts[src_data["id"]] = src_data
                artifacts[dst_data["id"]] = dst_data
                
                # Create dependency edge
                dependencies.append({
                    "from_id": src_data["id"],
                    "to_id": dst_data["id"],
                    "scope": dst_data.get("scope", "compile")
                })
                
    return list(artifacts.values()), dependencies


# =====================================================================
# 2. BULK GRAPH INGESTION VIA BOLT
# =====================================================================

class MavenGraphIngester:
    def __init__(self, uri: str = "bolt://localhost:7687", auth: Optional[Tuple[str, str]] = None):
        auth_token = auth if auth else ("neo4j", "")
        self.driver = GraphDatabase.driver(uri, auth=auth_token)

    def close(self):
        self.driver.close()

    def create_indexes(self):
        """Creates indexes to make UNWIND MERGE fast."""
        with self.driver.session() as session:
            # Works across both Neo4j and Memgraph
            session.run("CREATE INDEX ON :Artifact(id);")
            print(" Created index on :Artifact(id)")

    def bulk_insert(self, artifacts: List[Dict], dependencies: List[Dict]):
        with self.driver.session() as session:
            # 1. Bulk upsert all artifact nodes in a single transaction
            node_cypher = """
            UNWIND $batch AS row
            MERGE (a:Artifact {id: row.id})
            ON CREATE SET 
                a.groupId = row.groupId,
                a.artifactId = row.artifactId,
                a.packaging = row.packaging,
                a.version = row.version,
                a.created_at = timestamp()
            """
            session.run(node_cypher, {"batch": artifacts})
            print(f" Bulk-upserted {len(artifacts)} Artifact nodes.")

            # 2. Bulk upsert all DEPENDS_ON relationships
            edge_cypher = """
            UNWIND $batch AS row
            MATCH (source:Artifact {id: row.from_id})
            MATCH (target:Artifact {id: row.to_id})
            MERGE (source)-[r:DEPENDS_ON {scope: row.scope}]->(target)
            """
            session.run(edge_cypher, {"batch": dependencies})
            print(f" Bulk-created {len(dependencies)} [:DEPENDS_ON] relationships.")


# =====================================================================
# 3. EXECUTION
# =====================================================================

if __name__ == "__main__":
    dot_file_path = "../test/deps.dot"
    
    print(f"Parsing Maven DOT file: {dot_file_path}...")
    nodes, edges = parse_dot_file(dot_file_path)
    print(f"Extracted {len(nodes)} unique artifacts and {len(edges)} directed edges.\n")

    # Connect to local Memgraph (default: no auth) or Neo4j (e.g. auth=("neo4j", "password"))
    ingester = MavenGraphIngester(uri="bolt://localhost:7687", auth=("neo4j", ""))
    
    try:
        ingester.create_indexes()
        ingester.bulk_insert(nodes, edges)
        print("\n Ingestion complete! Open http://localhost:3000 to visualize.")
    finally:
        ingester.close()