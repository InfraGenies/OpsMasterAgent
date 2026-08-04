/**
 * The 9 demo scenarios from agent-md-files/USE_CASES.md plus the Enterprise
 * Architecture Advisor scenarios (UC-10..UC-12, agent-md-files/02c-compliance-check.md),
 * in one editable place. ChatInput.tsx renders these as chips. "roadmap"
 * entries still submit for real — they exercise the planner's
 * reasoning/refusal path even before the backend capability they'd ideally
 * use (multi-tier plans, Terraform) ships.
 */
export interface UseCase {
  id: string;
  label: string;
  text: string;
  status: "supported" | "roadmap";
}

export const USE_CASES: UseCase[] = [
  {
    id: "UC-2",
    label: "Dev todo app",
    text: "Spin up a dev environment for a simple Node.js todo app, low traffic, single instance.",
    status: "supported",
  },
  {
    id: "UC-1",
    label: "Staging @ 500 rps",
    text: "Create a staging environment for a Node.js application with PostgreSQL capable of handling 500 requests/second.",
    status: "supported",
  },
  {
    id: "UC-3",
    label: "Voting app (5 services)",
    text: "Provision a QA environment for a voting application with a vote frontend, results dashboard, Redis queue and Postgres, expecting 200 concurrent voters.",
    // Same limitation as UC-6: every compose template in templates/catalog.ts
    // covers exactly one app service. This plans correctly and then refuses
    // at readiness_check/iac_generator ("template_topology_supported" /
    // "no_template") — a real multi-service compose template is unbuilt.
    status: "roadmap",
  },
  {
    id: "UC-4",
    label: "LB, 3 replicas",
    text: "I need a load-balanced Node.js web tier with Redis, 3 replicas behind Nginx, for performance testing.",
    status: "supported",
  },
  {
    id: "UC-5",
    label: "Java Spring + MySQL",
    text: "Set up a test environment for a Java Spring Boot application with MySQL, ~50 users.",
    status: "supported",
  },
  {
    id: "UC-6",
    label: "Kubernetes (stretch)",
    text: "Deploy the Online Boutique storefront to a Kubernetes staging cluster with autoscaling on the frontend.",
    status: "roadmap",
  },
  {
    id: "UC-7",
    label: "Add Redis (modify)",
    text: "Add a Redis cache to the staging environment we just created and wire the app to it.",
    status: "supported",
  },
  {
    id: "UC-8a",
    label: "Refusal (50k rps)",
    text: "Provision production with 50,000 req/s and five-nines availability.",
    status: "supported",
  },
  {
    id: "UC-8b",
    label: "Rollback demo",
    text: "Create a staging environment for a Node.js application with PostgreSQL, 100 requests/second, demo-fail: use the wrong db password.",
    status: "supported",
  },
  {
    id: "UC-9",
    label: "AWS retail app (Terraform)",
    text: "Deploy the retail-store-sample-app to AWS for a staging environment — give me a cost-conscious option and a highly-available option, with pricing for each.",
    status: "supported",
  },
  {
    id: "UC-10",
    label: "Payment platform (PCI-DSS)",
    text: "We are launching a payment platform. Expected 8 million users. PCI-DSS compliant. Multi-region DR. RPO < 5 min. RTO < 15 min.",
    status: "supported",
  },
  {
    id: "UC-11a",
    label: "2-dev MVP",
    text: "We are 2 developers building an MVP.",
    status: "supported",
  },
  {
    id: "UC-11b",
    label: "Rescale to 500 devs",
    text: "We now have 500 developers across 20 teams.",
    status: "supported",
  },
  {
    id: "UC-12",
    label: "HIPAA healthcare startup",
    text: "HIPAA healthcare startup, 5 developers, single-region.",
    status: "supported",
  },
  {
    id: "UC-15",
    label: "Static frontend (Vite)",
    text: "Spin up a dev environment for a static React frontend built with Vite, no backend needed.",
    status: "supported",
  },
  {
    id: "UC-16",
    label: "Live hostname demo",
    text: "Give me a quick live demo endpoint that shows the container's own hostname on every request.",
    status: "supported",
  },
];
