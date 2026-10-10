import { describe, expect, it } from "vitest";
import { composeRelevantComment } from "@/lib/aws/comment";
import type { AwsCandidateInspection } from "@/lib/aws/site";

const candidate = { url: "https://builder.aws.com/content/FixtureArticle", title: "Build a data pipeline with AWS Glue and Athena" };
const inspection: AwsCandidateInspection = {
  liked: false, commented: false, commentsComplete: true,
  excerpt: `${candidate.title}. This walkthrough explains ingestion, transformation and querying in a practical pipeline. It uses S3 for storage, Glue for processing and Athena to query the results. The IAM role permissions are configured before executing the jobs.`
};

describe("relevant daily comments", () => {
  it("uses the actual article title and its primary topic before incidental services", () => {
    const text = composeRelevantComment(candidate, inspection);
    expect(text).toContain(candidate.title);
    expect(text).toContain("schema changes and failed records");
    expect(text).not.toContain("scope the permissions");
    expect(text.length).toBeLessThanOrEqual(500);
  });
  it("skips insufficient, unrelated or unsupported content before engagement", () => {
    expect(() => composeRelevantComment(candidate, { ...inspection, excerpt: "Short preview" })).toThrow("enough context");
    expect(() => composeRelevantComment(candidate, { ...inspection, excerpt: "Unrelated text. ".repeat(20) })).toThrow("enough context");
    const career = { ...candidate, title: "My personal career journey" };
    expect(() => composeRelevantComment(career, { ...inspection, excerpt: `${career.title}. ${"A personal account of my experiences. ".repeat(8)}` })).toThrow("article topic");
  });
});
