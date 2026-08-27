#!/usr/bin/env python3
"""
graph_to_drawio.py - Generate draw.io diagrams per APPLICATION from the graph.

Instead of dumping the whole account, this script:
1. Finds connected components in the graph (BFS over edges)
2. Each connected component = one "application" (resources that depend on each other)
3. Generates a separate .drawio file per application
4. Ignores orphan nodes (no edges = no application context)

Usage:
    python3 graph_to_drawio.py [--graph path/to/graph.json] [--output-dir docs/]
"""

import json
import sys
from collections import defaultdict, deque
from pathlib import Path
from xml.sax.saxutils import escape

# AWS resource type -> (mxgraph icon, fill color, category label)
ICON_MAP = {
    "AWS::EC2::VPC": ("mxgraph.aws4.vpc", "#8C4FFF", "Networking"),
    "AWS::EC2::Subnet": ("mxgraph.aws4.subnet", "#8C4FFF", "Networking"),
    "AWS::EC2::Instance": ("mxgraph.aws4.ec2", "#ED7100", "Compute"),
    "AWS::EC2::SecurityGroup": ("mxgraph.aws4.security_group", "#DD344C", "Security"),
    "AWS::EC2::InternetGateway": ("mxgraph.aws4.internet_gateway", "#8C4FFF", "Networking"),
    "AWS::EC2::NatGateway": ("mxgraph.aws4.nat_gateway", "#8C4FFF", "Networking"),
    "AWS::EC2::RouteTable": ("mxgraph.aws4.route_table", "#8C4FFF", "Networking"),
    "AWS::EC2::Volume": ("mxgraph.aws4.elastic_block_store", "#3F8624", "Storage"),
    "AWS::EC2::EIP": ("mxgraph.aws4.elastic_ip_address", "#8C4FFF", "Networking"),
    "AWS::ECS::Cluster": ("mxgraph.aws4.ecs", "#ED7100", "Compute"),
    "AWS::ECS::Service": ("mxgraph.aws4.ecs_service", "#ED7100", "Compute"),
    "AWS::ElasticLoadBalancingV2::LoadBalancer": ("mxgraph.aws4.application_load_balancer", "#8C4FFF", "Networking"),
    "AWS::ElasticLoadBalancingV2::TargetGroup": ("mxgraph.aws4.target_group", "#8C4FFF", "Networking"),
    "AWS::RDS::DBInstance": ("mxgraph.aws4.rds", "#C925D1", "Database"),
    "AWS::RDS::DBCluster": ("mxgraph.aws4.aurora", "#C925D1", "Database"),
    "AWS::S3::Bucket": ("mxgraph.aws4.s3", "#3F8624", "Storage"),
    "AWS::Lambda::Function": ("mxgraph.aws4.lambda_function", "#ED7100", "Compute"),
    "AWS::IAM::Role": ("mxgraph.aws4.role", "#DD344C", "Security"),
    "AWS::SecretsManager::Secret": ("mxgraph.aws4.secrets_manager", "#DD344C", "Security"),
    "AWS::Logs::LogGroup": ("mxgraph.aws4.cloudwatch", "#E7157B", "Management"),
    "AWS::Route53::HostedZone": ("mxgraph.aws4.route_53_hosted_zone", "#8C4FFF", "Networking"),
    "AWS::DynamoDB::Table": ("mxgraph.aws4.dynamodb", "#C925D1", "Database"),
    "AWS::ECR::Repository": ("mxgraph.aws4.ecr", "#ED7100", "Compute"),
    "AWS::SQS::Queue": ("mxgraph.aws4.sqs", "#E7157B", "Integration"),
    "AWS::SNS::Topic": ("mxgraph.aws4.sns", "#E7157B", "Integration"),
    "AWS::ElastiCache::CacheCluster": ("mxgraph.aws4.elasticache", "#C925D1", "Database"),
    "AWS::CloudFront::Distribution": ("mxgraph.aws4.cloudfront", "#8C4FFF", "Networking"),
}


def find_connected_components(nodes: list, edges: list) -> list[set[str]]:
    """Find connected components (undirected) in the graph."""
    node_ids = {n["id"] for n in nodes}
    adj: dict[str, set[str]] = defaultdict(set)

    for edge in edges:
        src, tgt = edge["source"], edge["target"]
        if src in node_ids and tgt in node_ids:
            adj[src].add(tgt)
            adj[tgt].add(src)

    visited: set[str] = set()
    components: list[set[str]] = []

    for node_id in node_ids:
        if node_id in visited or node_id not in adj:
            continue  # skip orphans (not in adj = no edges)
        # BFS
        component: set[str] = set()
        queue = deque([node_id])
        while queue:
            current = queue.popleft()
            if current in visited:
                continue
            visited.add(current)
            component.add(current)
            for neighbor in adj[current]:
                if neighbor not in visited:
                    queue.append(neighbor)
        if len(component) >= 2:  # at least 2 connected resources = an "application"
            components.append(component)

    # Sort by size descending (most interesting first)
    components.sort(key=len, reverse=True)
    return components


def generate_drawio_for_cluster(nodes: list, edges: list, title: str) -> str:
    """Generate draw.io XML for a single application cluster."""
    node_map = {n["id"]: n for n in nodes}
    cells = []
    cell_id = 10
    node_cell_map = {}

    # Title
    cells.append(
        f'<mxCell id="title" value="&lt;b&gt;{escape(title)}&lt;/b&gt;" '
        f'style="text;html=1;align=left;verticalAlign=top;fontSize=22;fontFamily=Helvetica;fontStyle=1;" '
        f'vertex="1" parent="1">'
        f'<mxGeometry x="20" y="20" width="800" height="35" as="geometry"/>'
        f'</mxCell>'
    )

    # Subtitle
    cells.append(
        f'<mxCell id="subtitle" value="{len(nodes)} resources | {len(edges)} relationships" '
        f'style="text;html=1;align=left;verticalAlign=top;fontSize=12;fontFamily=Helvetica;fontColor=#666666;" '
        f'vertex="1" parent="1">'
        f'<mxGeometry x="20" y="52" width="400" height="20" as="geometry"/>'
        f'</mxCell>'
    )

    # AWS Cloud boundary
    cols = min(len(nodes), 5)
    rows = (len(nodes) + cols - 1) // cols
    cloud_w = max(700, cols * 180 + 80)
    cloud_h = max(400, rows * 150 + 80)
    cells.append(
        f'<mxCell id="aws-cloud" value="AWS Cloud" '
        f'style="points=[];outlineConnect=0;gradientColor=none;html=1;whiteSpace=wrap;fontSize=12;fontStyle=1;'
        f'shape=mxgraph.aws4.group;grIcon=mxgraph.aws4.group_aws_cloud;strokeColor=#232F3E;fillColor=none;'
        f'verticalAlign=top;align=left;spacingLeft=30;fontColor=#232F3E;dashed=0;container=1;pointerEvents=0;fontFamily=Helvetica;" '
        f'vertex="1" parent="1">'
        f'<mxGeometry x="20" y="80" width="{cloud_w}" height="{cloud_h}" as="geometry"/>'
        f'</mxCell>'
    )

    # Place nodes in grid
    col = 0
    row = 0
    max_cols = cols

    for node in nodes:
        icon, fill_color, cat = ICON_MAP.get(node["type"], ("mxgraph.aws4.general_AWScloud", "#232F3E", "Other"))
        x = 40 + col * 180
        y = 40 + row * 150

        # Container
        container_id = f"c-{cell_id}"
        cells.append(
            f'<mxCell id="{container_id}" value="{escape(cat)}" '
            f'style="rounded=1;whiteSpace=wrap;html=1;fillColor=#F2F3F4;strokeColor=#D5DBDB;fontSize=9;'
            f'fontStyle=1;verticalAlign=bottom;fontFamily=Helvetica;container=1;pointerEvents=0;" '
            f'vertex="1" parent="aws-cloud">'
            f'<mxGeometry x="{x}" y="{y}" width="130" height="125" as="geometry"/>'
            f'</mxCell>'
        )
        cell_id += 1

        # Icon
        icon_id = f"i-{cell_id}"
        label = escape(node.get("name") or node["id"])[:30]
        cells.append(
            f'<mxCell id="{icon_id}" value="{label}" '
            f'style="sketch=0;outlineConnect=0;fontColor=#232F3E;gradientColor=none;fillColor={fill_color};'
            f'strokeColor=none;dashed=0;verticalLabelPosition=bottom;verticalAlign=top;align=center;html=1;'
            f'fontSize=9;fontStyle=0;shape=mxgraph.aws4.resourceIcon;resIcon={icon};fontFamily=Helvetica;" '
            f'vertex="1" parent="{container_id}">'
            f'<mxGeometry x="41" y="16" width="48" height="48" as="geometry"/>'
            f'</mxCell>'
        )
        node_cell_map[node["id"]] = icon_id
        cell_id += 1

        col += 1
        if col >= max_cols:
            col = 0
            row += 1

    # Edges
    for edge in edges:
        src_cell = node_cell_map.get(edge["source"])
        tgt_cell = node_cell_map.get(edge["target"])
        if src_cell and tgt_cell:
            edge_label = escape(edge.get("type", ""))
            cells.append(
                f'<mxCell id="e-{cell_id}" value="{edge_label}" '
                f'style="edgeStyle=orthogonalEdgeStyle;html=1;strokeColor=#666666;fontSize=8;fontFamily=Helvetica;'
                f'fontColor=#666666;" '
                f'edge="1" source="{src_cell}" target="{tgt_cell}" parent="1">'
                f'<mxGeometry relative="1" as="geometry"/>'
                f'</mxCell>'
            )
            cell_id += 1

    cells_xml = "\n        ".join(cells)
    return f'''<mxfile>
  <diagram name="{escape(title)}" id="diagram-1">
    <mxGraphModel dx="1400" dy="900" grid="0" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1920" pageHeight="1200">
      <root>
        <mxCell id="0"/>
        <mxCell id="1" parent="0"/>
        {cells_xml}
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>'''


def name_cluster(nodes: list) -> str:
    """Derive a meaningful name for a cluster from its key resources."""
    # Priority: ECS Service > Lambda > RDS > ALB > EC2 > first resource
    priority_types = [
        "AWS::ECS::Service", "AWS::Lambda::Function", "AWS::RDS::DBInstance",
        "AWS::ElasticLoadBalancingV2::LoadBalancer", "AWS::EC2::Instance",
        "AWS::CloudFront::Distribution"
    ]
    for ptype in priority_types:
        for n in nodes:
            if n["type"] == ptype:
                name = n.get("name") or n["id"]
                return name.replace("/", "-")[:40]
    # Fallback: first node
    return (nodes[0].get("name") or nodes[0]["id"]).replace("/", "-")[:40]


def main():
    import argparse
    parser = argparse.ArgumentParser(description="Generate draw.io diagrams per application cluster")
    parser.add_argument("--graph", default="data/graph/graph.json", help="Path to graph.json")
    parser.add_argument("--output-dir", default="docs", help="Output directory for .drawio files")
    parser.add_argument("--min-size", type=int, default=2, help="Minimum cluster size to generate a diagram")
    args = parser.parse_args()

    graph_path = Path(args.graph)
    if not graph_path.exists():
        print(f"Error: Graph file not found: {graph_path}", file=sys.stderr)
        sys.exit(1)

    graph = json.loads(graph_path.read_text())
    nodes = graph.get("nodes", [])
    edges = graph.get("edges", [])

    if not nodes:
        print("Error: Graph is empty (no nodes). Run build_graph first.", file=sys.stderr)
        sys.exit(1)

    # Find connected components (applications)
    components = find_connected_components(nodes, edges)

    if not components:
        print("No connected components found (no relationships in graph).", file=sys.stderr)
        print("The graph has nodes but no edges — resources are isolated.", file=sys.stderr)
        sys.exit(1)

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    node_map = {n["id"]: n for n in nodes}
    generated = []

    for i, component_ids in enumerate(components):
        if len(component_ids) < args.min_size:
            continue

        cluster_nodes = [node_map[nid] for nid in component_ids if nid in node_map]
        cluster_edges = [e for e in edges if e["source"] in component_ids and e["target"] in component_ids]

        cluster_name = name_cluster(cluster_nodes)
        title = f"Application: {cluster_name}"
        filename = f"app-{i+1}-{cluster_name.lower().replace(' ', '-')}.drawio"

        xml = generate_drawio_for_cluster(cluster_nodes, cluster_edges, title)
        out_path = output_dir / filename
        out_path.write_text(xml, encoding="utf-8")
        generated.append((out_path, len(cluster_nodes), len(cluster_edges)))

    # Summary
    print(f"\nGenerated {len(generated)} application diagram(s):\n")
    for path, n_nodes, n_edges in generated:
        print(f"  {path} ({n_nodes} resources, {n_edges} relationships)")

    print(f"\nOrphan resources (no relationships): {len(nodes) - sum(len(c) for c in components)}")
    print(f"\nTo preview in browser:")
    for path, _, _ in generated:
        print(f"  python3 skills/aws-architecture-diagram/scripts/drawio_url.py {path}")


if __name__ == "__main__":
    main()
