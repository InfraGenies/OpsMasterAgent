/**
 * All 9 demo scenarios from agent-md-files/USE_CASES.md, in one editable place.
 * ChatInput.tsx renders these as chips. "roadmap" entries still submit for
 * real — they exercise the planner's reasoning/refusal path even before the
 * backend capability they'd ideally use (multi-tier plans, Terraform) ships.
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
    status: "supported",
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
];
