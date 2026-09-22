import { describe, expect, it } from "vitest";
import { parseContentHtml } from "../src/content";

const IMAGE_URL = "https://cafeptthumb-phinf.pstatic.net/sample/photo.jpg?type=w800";
const STICKER_URL = "https://storep-phinf.pstatic.net/cafe_004/original_5.png?type=p50_50";

const SAMPLE = `<div class="se-viewer se-theme-default">
  <div class="se-main-container">
    <div class="se-component se-image se-l-default">
      <div class="se-module se-module-image">
        <a href="#" data-linkdata='{"src":"${IMAGE_URL}"}'>
          <img src="${IMAGE_URL}" alt="" class="se-image-resource" />
        </a>
      </div>
    </div>
    <div class="se-component se-text se-l-default">
      <div class="se-module se-module-text">
        <p class="se-text-paragraph"><span>머리에 드릴이 있어도 사람을 잘 꼬셔..</span></p>
      </div>
    </div>
    <div class="se-component se-sticker se-l-default">
      <div class="se-module se-module-sticker">
        <a href="#" class="__se_sticker_link"><img src="${STICKER_URL}" alt="스티커 대체 텍스트" class="se-sticker-image" /></a>
      </div>
    </div>
    <div class="se-component se-text">
      <div class="se-module se-module-text"><p><span>\u200b</span></p></div>
    </div>
  </div>
</div>`;

describe("parseContentHtml", () => {
  it("keeps content text and drops the sticker and its alt text", async () => {
    const parsed = await parseContentHtml(SAMPLE);
    expect(parsed.text).toBe("머리에 드릴이 있어도 사람을 잘 꼬셔..");
    expect(parsed.text).not.toContain("스티커");
  });

  it("collects only content images", async () => {
    const parsed = await parseContentHtml(SAMPLE);
    expect(parsed.images).toEqual([IMAGE_URL]);
  });

  it("separates paragraphs and keeps line breaks inside one", async () => {
    const parsed = await parseContentHtml("<p>첫 문단</p><p>둘째<br>줄</p>");
    expect(parsed.text).toBe("첫 문단\n\n둘째\n줄");
  });

  it("decodes entities and drops script and style content", async () => {
    const parsed = await parseContentHtml(
      `<script>var secret = 1;</script><style>.a{color:red}</style><p>&lt;b&gt; &amp; &quot;q&quot;</p>`,
    );
    expect(parsed.text).toBe('<b> & "q"');
  });

  it("returns empty results for empty content", async () => {
    expect(await parseContentHtml("")).toEqual({ text: "", images: [] });
  });

  it("keeps image order and removes duplicates", async () => {
    const html = `<div class="se-sticker"><img src="${STICKER_URL}" class="se-sticker-image" alt="sticker"></div>
      <img src="https://a.example/1.png" class="se-image-resource">
      <img src="https://a.example/2.png" class="se-image-resource">
      <img src="https://a.example/1.png" class="se-image-resource">`;
    const parsed = await parseContentHtml(html);
    expect(parsed.images).toEqual(["https://a.example/1.png", "https://a.example/2.png"]);
    expect(parsed.text).toBe("");
  });
});
