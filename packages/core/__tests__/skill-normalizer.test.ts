/**
 * Tests for packages/core/skills/normalizer.ts.
 *
 * Pins: determinism, idempotency, Claude pattern coverage, no-op for
 * unknown harnesses, no-op for code files (regex doesn't accidentally
 * mangle Python/JSON). Both server and CLI depend on this module
 * producing identical output for hash equality.
 */

import { describe, it, expect } from "bun:test";
import { normalize, isAlreadyCanonical, type NormalizableBundle } from "../skills/normalizer.js";

const claudeFlavored: NormalizableBundle = {
  body:
    "# code-review\n\n" +
    "Use `$ARGUMENTS[0]` as the branch and `$ARGUMENTS[1]` as the threshold.\n" +
    "Read `${CLAUDE_SKILL_DIR}/references/spec.md`.\n",
  supporting_files: [
    {
      path: "scripts/run.py",
      content: "#!/usr/bin/env python3\nimport os\nprint(os.environ['HOME'])\n",
    },
  ],
};

describe("skill normalizer — determinism + idempotency", () => {
  it("produces identical output across two calls", () => {
    const a = normalize(claudeFlavored, "claude");
    const b = normalize(claudeFlavored, "claude");
    expect(a).toEqual(b);
  });

  it("is idempotent: normalize(normalize(x)) === normalize(x)", () => {
    const once = normalize(claudeFlavored, "claude");
    const twice = normalize(once, "claude");
    expect(twice).toEqual(once);
  });

  it("does not mutate the input bundle", () => {
    const original = JSON.parse(JSON.stringify(claudeFlavored)) as NormalizableBundle;
    normalize(claudeFlavored, "claude");
    expect(claudeFlavored).toEqual(original);
  });
});

describe("skill normalizer — Claude pattern coverage", () => {
  it("rewrites $ARGUMENTS[0] to <the first argument>", () => {
    const out = normalize({ body: "Use $ARGUMENTS[0] now.", supporting_files: [] }, "claude");
    expect(out.body).toBe("Use <the first argument> now.");
  });

  it("rewrites $ARGUMENTS[N] for higher indexes", () => {
    const out = normalize({ body: "$ARGUMENTS[1] and $ARGUMENTS[2]", supporting_files: [] }, "claude");
    expect(out.body).toBe("<the second argument> and <the third argument>");
  });

  it("rewrites $N shorthand", () => {
    const out = normalize({ body: "use $0 and $1", supporting_files: [] }, "claude");
    expect(out.body).toBe("use <the first argument> and <the second argument>");
  });

  it("does not match $NAME / $foo / $word", () => {
    const out = normalize({ body: "$NAME $foo $word $$0 should not match", supporting_files: [] }, "claude");
    expect(out.body).toBe("$NAME $foo $word $$0 should not match");
  });

  it("rewrites ${CLAUDE_SESSION_ID}, ${CLAUDE_SKILL_DIR}, ${CLAUDE_EFFORT}", () => {
    const out = normalize(
      {
        body: "${CLAUDE_SESSION_ID} ${CLAUDE_SKILL_DIR} ${CLAUDE_EFFORT}",
        supporting_files: [],
      },
      "claude",
    );
    expect(out.body).toBe("<the session id> <the skill directory> <the effort level>");
  });
});

describe("skill normalizer — harness scoping", () => {
  it("is a no-op when harness is unknown (no patterns registered)", () => {
    const out = normalize(claudeFlavored, "goose-future-harness");
    expect(out).toEqual(claudeFlavored);
  });

  it("does not apply Claude patterns when harness is cursor", () => {
    const out = normalize({ body: "$ARGUMENTS[0]", supporting_files: [] }, "cursor");
    // No cursor patterns defined yet; body stays as-is.
    expect(out.body).toBe("$ARGUMENTS[0]");
  });
});

describe("skill normalizer — supporting files", () => {
  it("normalizes content of every supporting file", () => {
    const out = normalize(
      {
        body: "main body",
        supporting_files: [
          { path: "a.md", content: "Use $ARGUMENTS[0]." },
          { path: "b.md", content: "Use $ARGUMENTS[1]." },
        ],
      },
      "claude",
    );
    expect(out.supporting_files[0]?.content).toBe("Use <the first argument>.");
    expect(out.supporting_files[1]?.content).toBe("Use <the second argument>.");
  });

  it("is a no-op for code-style supporting files with no Claude tokens", () => {
    const codeFile: NormalizableBundle = {
      body: "main",
      supporting_files: [
        {
          path: "scripts/run.py",
          content: "import os\nprint(os.environ['HOME'])\n# $NOTACLAUDETOKEN stays\n",
        },
      ],
    };
    const out = normalize(codeFile, "claude");
    expect(out.supporting_files[0]?.content).toBe(codeFile.supporting_files[0]?.content);
  });
});

describe("skill normalizer — isAlreadyCanonical helper", () => {
  it("returns true when the body has no harness-specific tokens", () => {
    const canonical: NormalizableBundle = {
      body: "Plain markdown with no Claude tokens.",
      supporting_files: [{ path: "ref.md", content: "Just text." }],
    };
    expect(isAlreadyCanonical(canonical, "claude")).toBe(true);
  });

  it("returns false when the body contains $ARGUMENTS[0]", () => {
    expect(isAlreadyCanonical({ body: "Use $ARGUMENTS[0]", supporting_files: [] }, "claude")).toBe(false);
  });

  it("returns false when a supporting file contains harness tokens", () => {
    expect(
      isAlreadyCanonical(
        {
          body: "main",
          supporting_files: [{ path: "ref.md", content: "${CLAUDE_SESSION_ID}" }],
        },
        "claude",
      ),
    ).toBe(false);
  });
});
