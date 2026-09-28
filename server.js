require("dotenv").config();

const express = require("express");
const cookieParser = require("cookie-parser");
const multer = require("multer");
const crypto = require("crypto");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const app = express();

const PORT = process.env.PORT || 3000;

const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SECRET_KEY in .env");
  process.exit(1);
}

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SECRET_KEY
);

const BUCKET_NAME = "blog-images";

const sessions = new Map();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      return cb(new Error("Only image files are allowed."));
    }

    cb(null, true);
  }
});

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.use(express.static(path.join(__dirname, "public")));

function makeSlug(title) {
  return String(title)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function requireAdmin(req, res, next) {
  const token = req.cookies.admin_session;

  if (!token || !sessions.has(token)) {
    return res.status(401).json({
      error: "Unauthorized"
    });
  }

  next();
}

/* =========================
   LOGIN
========================= */

app.post("/api/login", (req, res) => {
  const { username, password } = req.body;

  if (
    username !== ADMIN_USERNAME ||
    password !== ADMIN_PASSWORD
  ) {
    return res.status(401).json({
      error: "Invalid username or password"
    });
  }

  const token = crypto.randomBytes(32).toString("hex");

  sessions.set(token, {
    createdAt: Date.now()
  });

  res.cookie("admin_session", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 1000 * 60 * 60 * 24 * 7
  });

  res.json({
    success: true
  });
});

/* =========================
   LOGOUT
========================= */

app.post("/api/logout", (req, res) => {
  const token = req.cookies.admin_session;

  if (token) {
    sessions.delete(token);
  }

  res.clearCookie("admin_session");

  res.json({
    success: true
  });
});

/* =========================
   PUBLIC ARTICLES
========================= */

app.get("/api/articles", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("articles")
      .select("*")
      .eq("published", true)
      .order("created_at", { ascending: false });

    if (error) {
      console.error(error);
      return res.status(500).json({
        error: "Could not load articles"
      });
    }

    res.json(data || []);
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Could not load articles"
    });
  }
});

/* =========================
   PUBLIC SINGLE ARTICLE
========================= */

app.get("/api/articles/:slug", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("articles")
      .select("*")
      .eq("slug", req.params.slug)
      .eq("published", true)
      .single();

    if (error || !data) {
      return res.status(404).json({
        error: "Article not found"
      });
    }

    res.json(data);
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Could not load article"
    });
  }
});

/* =========================
   ADMIN ARTICLES
========================= */

app.get("/api/admin/articles", requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("articles")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) {
      console.error(error);

      return res.status(500).json({
        error: "Could not load admin articles"
      });
    }

    res.json(data || []);
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Could not load admin articles"
    });
  }
});

/* =========================
   ADMIN SINGLE ARTICLE
========================= */

app.get(
  "/api/admin/articles/:id",
  requireAdmin,
  async (req, res) => {
    try {
      const { data, error } = await supabase
        .from("articles")
        .select("*")
        .eq("id", req.params.id)
        .single();

      if (error || !data) {
        return res.status(404).json({
          error: "Article not found"
        });
      }

      res.json(data);
    } catch (error) {
      console.error(error);

      res.status(500).json({
        error: "Could not load article"
      });
    }
  }
);

/* =========================
   UPLOAD IMAGE
========================= */

app.post(
  "/api/admin/upload",
  requireAdmin,
  upload.single("image"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          error: "No image uploaded"
        });
      }

      const extension =
        path.extname(req.file.originalname).toLowerCase() ||
        ".jpg";

      const fileName =
        `${Date.now()}-${crypto.randomBytes(8).toString("hex")}${extension}`;

      const filePath = `articles/${fileName}`;

      const { error } = await supabase.storage
        .from(BUCKET_NAME)
        .upload(filePath, req.file.buffer, {
          contentType: req.file.mimetype,
          upsert: false
        });

      if (error) {
        console.error(error);

        return res.status(500).json({
          error: "Image upload failed"
        });
      }

      const {
        data: publicUrlData
      } = supabase.storage
        .from(BUCKET_NAME)
        .getPublicUrl(filePath);

      res.json({
        url: publicUrlData.publicUrl
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        error: "Image upload failed"
      });
    }
  }
);

/* =========================
   CREATE ARTICLE
========================= */

app.post(
  "/api/admin/articles",
  requireAdmin,
  async (req, res) => {
    try {
      const {
        title,
        excerpt,
        content,
        category,
        published,
        image_url
      } = req.body;

      if (!title || !title.trim()) {
        return res.status(400).json({
          error: "Title is required"
        });
      }

      let slug = makeSlug(title);

      if (!slug) {
        slug = `article-${Date.now()}`;
      }

      const { data: existing } = await supabase
        .from("articles")
        .select("id")
        .eq("slug", slug)
        .limit(1);

      if (existing && existing.length > 0) {
        slug = `${slug}-${Date.now()}`;
      }

      const { data, error } = await supabase
        .from("articles")
        .insert({
          title: title.trim(),
          slug,
          excerpt: excerpt || "",
          content: content || "",
          category: category || "Mind",
          published: Boolean(published),
          image_url: image_url || null
        })
        .select()
        .single();

      if (error) {
        console.error(error);

        return res.status(500).json({
          error: "Could not create article"
        });
      }

      res.json(data);
    } catch (error) {
      console.error(error);

      res.status(500).json({
        error: "Could not create article"
      });
    }
  }
);

/* =========================
   UPDATE ARTICLE
========================= */

app.put(
  "/api/admin/articles/:id",
  requireAdmin,
  async (req, res) => {
    try {
      const {
        title,
        excerpt,
        content,
        category,
        published,
        image_url
      } = req.body;

      if (!title || !title.trim()) {
        return res.status(400).json({
          error: "Title is required"
        });
      }

      const { data: currentArticle, error: findError } =
        await supabase
          .from("articles")
          .select("*")
          .eq("id", req.params.id)
          .single();

      if (findError || !currentArticle) {
        return res.status(404).json({
          error: "Article not found"
        });
      }

      let slug = currentArticle.slug;

      if (title.trim() !== currentArticle.title) {
        slug = makeSlug(title);

        if (!slug) {
          slug = `article-${Date.now()}`;
        }

        const { data: duplicate } = await supabase
          .from("articles")
          .select("id")
          .eq("slug", slug)
          .neq("id", req.params.id)
          .limit(1);

        if (duplicate && duplicate.length > 0) {
          slug = `${slug}-${Date.now()}`;
        }
      }

      const updateData = {
        title: title.trim(),
        slug,
        excerpt: excerpt || "",
        content: content || "",
        category: category || "Mind",
        published: Boolean(published),
        image_url:
          image_url !== undefined
            ? image_url || null
            : currentArticle.image_url,
        updated_at: new Date().toISOString()
      };

      const { data, error } = await supabase
        .from("articles")
        .update(updateData)
        .eq("id", req.params.id)
        .select()
        .single();

      if (error) {
        console.error(error);

        return res.status(500).json({
          error: "Could not update article"
        });
      }

      res.json(data);
    } catch (error) {
      console.error(error);

      res.status(500).json({
        error: "Could not update article"
      });
    }
  }
);

/* =========================
   DELETE ARTICLE
========================= */

app.delete(
  "/api/admin/articles/:id",
  requireAdmin,
  async (req, res) => {
    try {
      const { error } = await supabase
        .from("articles")
        .delete()
        .eq("id", req.params.id);

      if (error) {
        console.error(error);

        return res.status(500).json({
          error: "Could not delete article"
        });
      }

      res.json({
        success: true
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        error: "Could not delete article"
      });
    }
  }
);

/* =========================
   ERROR HANDLER
========================= */

app.use((err, req, res, next) => {
  console.error(err);

  if (err instanceof multer.MulterError) {
    return res.status(400).json({
      error: err.message
    });
  }

  res.status(500).json({
    error: err.message || "Server error"
  });
});

/* =========================
   START SERVER
========================= */

app.listen(PORT, () => {
  console.log(`Blog server running on port ${PORT}`);
});