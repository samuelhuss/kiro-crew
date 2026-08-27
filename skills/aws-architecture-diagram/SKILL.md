---
name: aws-architecture-diagram
description: "Generate AWS architecture diagrams as draw.io XML using official AWS4 icons. Can auto-generate from the infrastructure graph (graph.json) or brainstorm interactively. Supports AS-IS (current state) and TO-BE (target architecture after migration) modes."
argument-hint: "[describe architecture, or 'from-graph' to use discovered infrastructure]"
---

# AWS Architecture Diagram Generator

Generate validated draw.io XML files with official AWS4 icons from:
1. **The infrastructure graph** (auto-generate from `data/graph/graph.json`)
2. **Interactive brainstorming** (describe what you want)
3. **Migration comparison** (AS-IS vs TO-BE side by side)

## Workflow

### Mode A — From Infrastructure Graph (recommended)

When the user says "generate diagram", "visualize infrastructure", "from graph", or "show architecture":

1. Read `data/graph/graph.json` to get nodes and edges
2. Group nodes by service type (EC2, ECS, RDS, Lambda, etc.)
3. Map each `ResourceType` to the correct `mxgraph.aws4.*` shape:
   - `AWS::EC2::VPC` → `mxgraph.aws4.vpc`
   - `AWS::EC2::Subnet` → `mxgraph.aws4.subnet`
   - `AWS::EC2::Instance` → `mxgraph.aws4.ec2`
   - `AWS::EC2::SecurityGroup` → `mxgraph.aws4.security_group`
   - `AWS::ECS::Cluster` → `mxgraph.aws4.ecs`
   - `AWS::ECS::Service` → `mxgraph.aws4.ecs_service`
   - `AWS::ElasticLoadBalancingV2::LoadBalancer` → `mxgraph.aws4.application_load_balancer`
   - `AWS::RDS::DBInstance` → `mxgraph.aws4.rds`
   - `AWS::S3::Bucket` → `mxgraph.aws4.s3`
   - `AWS::Lambda::Function` → `mxgraph.aws4.lambda_function`
   - `AWS::IAM::Role` → `mxgraph.aws4.role`
   - `AWS::DynamoDB::Table` → `mxgraph.aws4.dynamodb`
   - `AWS::CloudFront::Distribution` → `mxgraph.aws4.cloudfront`
   - `AWS::Route53::HostedZone` → `mxgraph.aws4.route_53`
   - `AWS::SQS::Queue` → `mxgraph.aws4.sqs`
   - `AWS::SNS::Topic` → `mxgraph.aws4.sns`
   - `AWS::ElastiCache::CacheCluster` → `mxgraph.aws4.elasticache`
   - `AWS::ECR::Repository` → `mxgraph.aws4.ecr`
   - `AWS::Logs::LogGroup` → `mxgraph.aws4.cloudwatch`
4. Create VPC/subnet containers from the graph relationships (BELONGS_TO, RUNS_IN)
5. Draw edges from graph relationships with appropriate labels
6. Generate the draw.io XML

### Mode B — Brainstorming

When the user describes an architecture or says "brainstorm"/"design":
1. Ask 3-5 focused questions (purpose, services, scale, traffic pattern)
2. Propose the architecture
3. Generate the diagram

### Mode C — Migration Comparison (AS-IS vs TO-BE)

When the user says "compare", "before/after", "migration diagram":
1. Read graph.json for AS-IS
2. Ask what changes in the target (different account, different services, etc.)
3. Generate two diagrams or a split view

## XML Generation Rules

### Required Structure
```xml
<mxfile>
  <diagram name="Architecture" id="diagram-1">
    <mxGraphModel dx="1200" dy="800" grid="0" gridSize="10"
                  guides="1" tooltips="1" connect="1" arrows="1"
                  fold="1" page="1" pageScale="1" pageWidth="1600" pageHeight="1200">
      <root>
        <mxCell id="0"/>
        <mxCell id="1" parent="0"/>
        <!-- Title -->
        <mxCell id="title" value="&lt;b&gt;Architecture Title&lt;/b&gt;" 
                style="text;html=1;align=left;verticalAlign=top;fontSize=30;fontFamily=Helvetica;"
                vertex="1" parent="1">
          <mxGeometry x="20" y="20" width="600" height="40" as="geometry"/>
        </mxCell>
        <!-- AWS Cloud boundary -->
        <mxCell id="aws-cloud" value="AWS Cloud"
                style="points=[];outlineConnect=0;gradientColor=none;html=1;whiteSpace=wrap;fontSize=12;fontStyle=1;shape=mxgraph.aws4.group;grIcon=mxgraph.aws4.group_aws_cloud;strokeColor=#232F3E;fillColor=none;verticalAlign=top;align=left;spacingLeft=30;fontColor=#232F3E;dashed=0;container=1;pointerEvents=0;fontFamily=Helvetica;"
                vertex="1" parent="1">
          <mxGeometry x="20" y="80" width="1200" height="800" as="geometry"/>
        </mxCell>
        <!-- Services go here -->
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>
```

### Service Icon Pattern
```xml
<!-- Container (120x120, category tint color) -->
<mxCell id="svc-container" value="Compute"
        style="rounded=1;whiteSpace=wrap;html=1;fillColor=#F2F3F4;strokeColor=#D5DBDB;fontSize=12;fontStyle=1;verticalAlign=bottom;fontFamily=Helvetica;container=1;pointerEvents=0;"
        vertex="1" parent="aws-cloud">
  <mxGeometry x="100" y="100" width="120" height="120" as="geometry"/>
</mxCell>
<!-- Icon (48x48, centered inside container) -->
<mxCell id="ec2-instance" value="Web Server"
        style="sketch=0;outlineConnect=0;fontColor=#232F3E;gradientColor=none;fillColor=#ED7100;strokeColor=none;dashed=0;verticalLabelPosition=bottom;verticalAlign=top;align=center;html=1;fontSize=10;fontStyle=0;shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.ec2;fontFamily=Helvetica;"
        vertex="1" parent="svc-container">
  <mxGeometry x="36" y="20" width="48" height="48" as="geometry"/>
</mxCell>
```

### Edge Pattern
```xml
<mxCell id="edge-1" value="" style="edgeStyle=orthogonalEdgeStyle;html=1;strokeColor=#232F3E;fontFamily=Helvetica;"
        edge="1" source="ec2-instance" target="rds-db" parent="1">
  <mxGeometry relative="1" as="geometry"/>
</mxCell>
```

## Defaults
- **Font**: `fontFamily=Helvetica` everywhere
- **Icon size**: 48x48 inside 120x120 containers
- **Spacing**: 180px horizontal, 120px vertical
- **File location**: `./docs/` directory
- **Grid**: OFF (`grid=0`)

## Category Tint Colors (container fills)
- Compute (EC2, Lambda, ECS): `#ED7100`
- Database (RDS, DynamoDB, ElastiCache): `#C925D1`
- Storage (S3, EBS): `#3F8624`
- Networking (VPC, ELB, CloudFront, Route53): `#8C4FFF`
- Security/Identity (IAM, SG): `#DD344C`
- Application Integration (SQS, SNS, EventBridge): `#E7157B`
- Management (CloudWatch, CloudTrail): `#E7157B`

## Preview URL Generation

After writing the `.drawio` file, generate a preview URL:
```bash
python3 skills/aws-architecture-diagram/scripts/drawio_url.py ./docs/<file>.drawio
```
This outputs a URL that opens the diagram directly in app.diagrams.net (no account needed).

## Output
1. Write `.drawio` file to `./docs/`
2. Generate and display the preview URL
3. Report: file path, diagram type, services included, and the clickable URL
