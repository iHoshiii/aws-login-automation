import { handle, json, protectMutation } from "@/lib/http";
import { addPost } from "@/lib/repository";
import { readBody, postUrl, stringValue } from "@/lib/validation";

export async function POST(request: Request) {
  return handle(async () => {
    await protectMutation(request);
    const body = await readBody(request);
    return json({ post: await addPost({ url: postUrl(body.url), title: stringValue(body.title, "Title", 200) }) }, 201);
  });
}
