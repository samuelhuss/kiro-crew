# Migration Manifest

**Source:** us-east-1  |  **Target:** sa-east-1
**Generated:** 2026-08-28T19:53:33.647Z

## Summary

| Metric | Count |
|--------|-------|
| Resources to migrate | 7 |
| Full fidelity (IaC Generator) | 6 |
| Partial (config + manual data) | 1 |
| Manual only | 0 |
| With data migration | 2 |
| With blockers | 2 |
| Orphan resources (not migrated) | 179 |

## Migration Cost (one-time + temporary)

- **Data to transfer:** 16 GB
- **One-time transfer cost:** ~$0.32
- **Temporary snapshot storage:** ~$1.6/month (until cutover)

## Resources

### tstsrv-vpc (`vpc-0e6ded7d310cad65d`)

- **What it is:** EC2 VPC "tstsrv-vpc" (available) in us-east-1
- **Will be created:** An identical EC2 VPC recreated in sa-east-1 from its faithful CloudFormation
- **Fidelity:** ✅ FULL — IaC Generator produces faithful CloudFormation from the real config
- **Changes:** Resource ID changes (new VPC created in sa-east-1)

### tstsrv-Public-1 (`subnet-0c93b4f6791bca46b`)

- **What it is:** EC2 Subnet "tstsrv-Public-1" (available) in us-east-1
- **Will be created:** An identical EC2 Subnet recreated in sa-east-1 from its faithful CloudFormation
- **Fidelity:** ✅ FULL — IaC Generator produces faithful CloudFormation from the real config
- **Changes:** Resource ID changes (new Subnet created in sa-east-1)
- **Depends on:** vpc-0e6ded7d310cad65d, rtb-05daf230a9e705da8

### tstsrv-Public-rtb (`rtb-05daf230a9e705da8`)

- **What it is:** EC2 RouteTable "tstsrv-Public-rtb" in us-east-1
- **Will be created:** An identical EC2 RouteTable recreated in sa-east-1 from its faithful CloudFormation
- **Fidelity:** ✅ FULL — IaC Generator produces faithful CloudFormation from the real config
- **Changes:** Resource ID changes (new RouteTable created in sa-east-1)

### tstsrv-igw (`igw-0c25b97625bacfc66`)

- **What it is:** EC2 InternetGateway "tstsrv-igw" in us-east-1
- **Will be created:** An identical EC2 InternetGateway recreated in sa-east-1 from its faithful CloudFormation
- **Fidelity:** ✅ FULL — IaC Generator produces faithful CloudFormation from the real config
- **Changes:** Resource ID changes (new InternetGateway created in sa-east-1)
- **Depends on:** vpc-0e6ded7d310cad65d

### tstsrv-sg (`sg-0a39c5a932937abb7`)

- **What it is:** EC2 SecurityGroup "tstsrv-sg" in us-east-1
- **Will be created:** An identical EC2 SecurityGroup recreated in sa-east-1 from its faithful CloudFormation
- **Fidelity:** ✅ FULL — IaC Generator produces faithful CloudFormation from the real config
- **Changes:** Resource ID changes (new SecurityGroup created in sa-east-1)
- **Depends on:** vpc-0e6ded7d310cad65d

### tstsrv-webserver (`i-0cb0ec5e82b386af3`)

- **What it is:** EC2 Instance "tstsrv-webserver" (type t2.micro, running) in us-east-1
- **Will be created:** A EC2 Instance in sa-east-1 restored from a copied snapshot (data preserved)
- **Fidelity:** ⚠️ PARTIAL — Config reproducible, but data/secrets/AMI need manual handling
- **Changes:** Resource ID changes (new Instance created in sa-east-1); New private IP (target subnet CIDR); AMI must be copied cross-region
- **Depends on:** subnet-0c93b4f6791bca46b, vpc-0e6ded7d310cad65d, sg-0a39c5a932937abb7
- **Data migration (AMI_COPY):**
  - Create AMI from the source instance (captures OS + root disk + config)
    ```
    aws ec2 create-image --region us-east-1 --instance-id i-0cb0ec5e82b386af3 --name "tstsrv-webserver-migration-1787946813647" --no-reboot
    ```
  - Wait for the AMI to be available
    ```
    aws ec2 wait image-available --region us-east-1 --image-ids <source-ami-id>
    ```
  - Copy the AMI to sa-east-1
    ```
    aws ec2 copy-image --source-region us-east-1 --region sa-east-1 --source-image-id <source-ami-id> --name "tstsrv-webserver-migration-1787946813647"
    ```
  - **CFN reference:** ImageId (use the copied AMI ID as the ImageId parameter in the CFN)
  - **Cost:** ~$0.16 transfer + ~$0.8/mo storage
- **⚠️ Manual actions:**
  - Copy the AMI to sa-east-1 and validate volume/data handling.
  - Run data migration (AMI_COPY) before creating the target resource — see commands
- **🚫 Blockers:**
  - [HIGH] CROSS_REGION_DATA_TRANSFER_REQUIRED: AMI and EBS volume data must be transferred across regions.

###  (`vol-03f644edd54a44f76`)

- **What it is:** EC2 Volume "" (in-use, 8GB) in us-east-1
- **Will be created:** A EC2 Volume in sa-east-1 restored from a copied snapshot (data preserved)
- **Fidelity:** ✅ FULL — IaC Generator produces faithful CloudFormation from the real config
- **Changes:** Resource ID changes (new Volume created in sa-east-1)
- **Data migration (EBS_SNAPSHOT_COPY):**
  - Create a snapshot of the source volume
    ```
    aws ec2 create-snapshot --region us-east-1 --volume-id vol-03f644edd54a44f76 --description "migration vol-03f644edd54a44f76"
    ```
  - Copy snapshot to sa-east-1
    ```
    aws ec2 copy-snapshot --source-region us-east-1 --region sa-east-1 --source-snapshot-id <source-snap-id>
    ```
  - **CFN reference:** SnapshotId (reference the copied snapshot in the Volume CFN)
  - **Cost:** ~$0.16 transfer + ~$0.8/mo storage
- **⚠️ Manual actions:**
  - Run data migration (EBS_SNAPSHOT_COPY) before creating the target resource — see commands
- **🚫 Blockers:**
  - [MEDIUM] CROSS_REGION_DATA_TRANSFER_REQUIRED: EBS snapshot must be copied to the target region before restore.
