import { AwsSiteError, type AwsCandidate, type AwsCandidateInspection } from "./site";

const topics = [
  { pattern: /\b(?:data pipeline|data engineering|ETL|AWS Glue|Athena)\b/i, name: "the data pipeline", question: "How would you handle schema changes and failed records as the pipeline grows?" },
  { pattern: /\b(?:IAM|least privilege|security|permissions)\b/i, name: "the security model", question: "How would you scope the permissions for a production deployment?" },
  { pattern: /\b(?:Bedrock|generative AI|AI agent|LLM|machine learning)\b/i, name: "the AI workflow", question: "How would you evaluate the quality of the outputs before moving this into production?" },
  { pattern: /\b(?:DynamoDB|database|SQL|indexing)\b/i, name: "the database design", question: "Which query patterns would you measure first before choosing an indexing strategy?" },
  { pattern: /\b(?:Lambda|serverless)\b/i, name: "the serverless approach", question: "How would you test retry behavior and monitor failed invocations in production?" },
  { pattern: /\b(?:EKS|ECS|Kubernetes|Docker|containers)\b/i, name: "the container deployment", question: "How would you handle failed health checks during a rolling deployment?" },
  { pattern: /\b(?:VPC|networking|network architecture)\b/i, name: "the network design", question: "Which network metrics would you watch first when validating the configuration?" },
  { pattern: /\b(?:cost optimization|pricing|cost savings)\b/i, name: "the cost comparison", question: "Which cost metric would you monitor first when comparing this approach with the alternatives?" },
  { pattern: /\b(?:CDK|CloudFormation|Terraform|infrastructure as code)\b/i, name: "the infrastructure setup", question: "What would you validate in a small test environment before deploying this more widely?" },
  { pattern: /\b(?:Amazon S3|S3 bucket|object storage)\b/i, name: "the storage setup", question: "How would you choose the lifecycle rules as the data volume grows?" }
];

/** Use a topic present in the inspected article; never reuse the generic "nice" default. */
export function composeRelevantComment(candidate: AwsCandidate, inspection: AwsCandidateInspection): string {
  const title = Array.from(candidate.title, character => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? " " : character;
  }).join("").replace(/\s+/g, " ").trim();
  const content = inspection.excerpt.replace(/\s+/g, " ").trim();
  if (title.length < 12 || title.length > 180 || content.length < 180 || !content.toLowerCase().includes(title.toLowerCase())) {
    throw new AwsSiteError("state_unknown", "The inspected article does not contain enough context for a relevant comment.");
  }
  // Prefer the title's topic over incidental service mentions in the article body.
  const topic = topics.find(topic => topic.pattern.test(title)) ?? topics.find(topic => topic.pattern.test(content));
  if (!topic) throw new AwsSiteError("state_unknown", "The inspected article topic cannot be used for a relevant automatic comment.");
  return `Thanks for sharing “${title}”. The discussion of ${topic.name} is useful. ${topic.question}`;
}
