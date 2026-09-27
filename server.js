require("dotenv").config();

const express = require("express");
const cookieParser = require("cookie-parser");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// -------------------------
// FOLDERS & FILES
// -------------------------

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const UPLOADS_DIR = path.join(ROOT, "uploads");
const DATA_DIR = path.join(ROOT, "data");
const DATA_FILE = path.join(DATA_DIR, "articles.json");

fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, "[]", "utf8");
}

// -------------------------
// ARTICLE STORAGE
// -------------------------

function readArticles() {
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const articles = JSON.parse(raw);

    return Array.isArray(articles) ? articles : [];
  } catch (error) {
    console.error("Could not read articles:", error);
    return [];
  }
}

function writeArticles(articles) {
  const tempFile = DATA_FILE + ".tmp";

  fs.writeFileSync(
    tempFile,
    JSON.stringify(articles, null, 2),
    "utf8"
  );

  fs.renameSync(tempFile, DATA_FILE);
}

// -------------------------
// SLUG CREATOR
// -------------------------

function slugify(text) {
  return text
    .toString()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "article";
}

function uniqueSlug(title, articles, excludeId = null) {
  const base = slugify(title);

  let slug = base;
  let number = 2;

  while (
    articles.some(
      article =>
        article.slug === slug &&
        article.id !== excludeId
    )
  ) {
    slug = `${base}-${number}`;
    number++;
  }

  return slug;
}

// -------------------------
// ARTICLE CLEANUP
// -------------------------

function sanitizeArticle(article) {
  return {
    id: article.id,
    title: article.title,
    slug: article.slug,
    category: article.category,
    excerpt: article.excerpt,
    content: article.content,
    published: article.published,
    image_url: article.image_url,
    created_at: article.created_at,
    updated_at: article.updated_at
  };
}

// -------------------------
// MIDDLEWARE
// -------------------------

app.use(express.json({ limit: "2mb" }));
app.use(cookieParser());

app.use("/uploads", express.static(UPLOADS_DIR));
app.use(express.static(PUBLIC_DIR));

// -------------------------
// LOGIN SYSTEM
// -------------------------

const sessions = new Map();

function requireAdmin(req, res, next) {
  const token = req.cookies.admin_session;

  if (!token || !sessions.has(token)) {
    return res.status(401).json({
      error: "Unauthorized"
    });
  }

  next();
}

// -------------------------
// LOGIN
// -------------------------

app.post("/api/login", (req, res) => {
  const { username, password } = req.body || {};

  if (
    username === process.env.ADMIN_USERNAME &&
    password === process.env.ADMIN_PASSWORD
  ) {
    const token = crypto.randomBytes(32).toString("hex");

    sessions.set(token, {
      createdAt: Date.now()
    });

    res.cookie("admin_session", token, {
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      maxAge: 1000 * 60 * 60 * 24
    });

    return res.json({
      ok: true
    });
  }

  res.status(401).json({
    error: "Invalid username or password"
  });
});

// -------------------------
// LOGOUT
// -------------------------

app.post("/api/logout", (req, res) => {
  const token = req.cookies.admin_session;

  if (token) {
    sessions.delete(token);
  }

  res.clearCookie("admin_session");

  res.json({
    ok: true
  });
});

// -------------------------
// IMAGE UPLOAD
// -------------------------

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, callback) => {
      callback(null, UPLOADS_DIR);
    },

    filename: (req, file, callback) => {
      const extension = path.extname(file.originalname).toLowerCase();

      const filename =
        `${Date.now()}-` +
        `${crypto.randomBytes(6).toString("hex")}` +
        extension;

      callback(null, filename);
    }
  }),

  limits: {
    fileSize: 10 * 1024 * 1024
  },

  fileFilter: (req, file, callback) => {
    if (
      file.mimetype &&
      file.mimetype.startsWith("image/")
    ) {
      callback(null, true);
    } else {
      callback(new Error("Only image files are allowed."));
    }
  }
});

// -------------------------
// UPLOAD IMAGE
// -------------------------

app.post(
  "/api/admin/upload",
  requireAdmin,
  upload.single("image"),
  (req, res) => {
    if (!req.file) {
      return res.status(400).json({
        error: "No image uploaded"
      });
    }

    res.json({
      url: `/uploads/${req.file.filename}`
    });
  }
);

// -------------------------
// PUBLIC ARTICLES
// -------------------------

app.get("/api/articles", (req, res) => {
  const articles = readArticles()
    .filter(article => article.published)
    .sort(
      (a, b) =>
        new Date(b.created_at) -
        new Date(a.created_at)
    );

  res.json(
    articles.map(sanitizeArticle)
  );
});

// -------------------------
// PUBLIC SINGLE ARTICLE
// -------------------------

app.get("/api/articles/:slug", (req, res) => {
  const article = readArticles().find(
    article =>
      article.published &&
      article.slug === req.params.slug
  );

  if (!article) {
    return res.status(404).json({
      error: "Article not found"
    });
  }

  res.json(
    sanitizeArticle(article)
  );
});

// -------------------------
// ADMIN — ALL ARTICLES
// -------------------------

app.get(
  "/api/admin/articles",
  requireAdmin,
  (req, res) => {
    const articles = readArticles()
      .sort(
        (a, b) =>
          new Date(b.updated_at) -
          new Date(a.updated_at)
      );

    res.json(
      articles.map(sanitizeArticle)
    );
  }
);

// -------------------------
// ADMIN — ONE ARTICLE
// -------------------------

app.get(
  "/api/admin/articles/:id",
  requireAdmin,
  (req, res) => {
    const id = Number(req.params.id);

    const article = readArticles().find(
      article => article.id === id
    );

    if (!article) {
      return res.status(404).json({
        error: "Article not found"
      });
    }

    res.json(
      sanitizeArticle(article)
    );
  }
);

// -------------------------
// CREATE ARTICLE
// -------------------------

app.post(
  "/api/admin/articles",
  requireAdmin,
  (req, res) => {
    const {
      title,
      category,
      excerpt,
      content,
      published,
      image_url
    } = req.body || {};

    if (!title || !content) {
      return res.status(400).json({
        error: "Title and content are required"
      });
    }

    const articles = readArticles();

    const now = new Date().toISOString();

    const article = {
      id: Date.now(),

      title: title.trim(),

      slug: uniqueSlug(
        title,
        articles
      ),

      category: category || "Mind",

      excerpt: excerpt || "",

      content: content.trim(),

      published: Boolean(published),

      image_url: image_url || null,

      created_at: now,

      updated_at: now
    };

    articles.push(article);

    writeArticles(articles);

    res.status(201).json(
      sanitizeArticle(article)
    );
  }
);

// -------------------------
// UPDATE ARTICLE
// -------------------------

app.put(
  "/api/admin/articles/:id",
  requireAdmin,
  (req, res) => {
    const id = Number(req.params.id);

    const articles = readArticles();

    const index = articles.findIndex(
      article => article.id === id
    );

    if (index === -1) {
      return res.status(404).json({
        error: "Article not found"
      });
    }

    const oldArticle = articles[index];

    const {
      title,
      category,
      excerpt,
      content,
      published,
      image_url
    } = req.body || {};

    if (!title || !content) {
      return res.status(400).json({
        error: "Title and content are required"
      });
    }

    const updatedArticle = {
      ...oldArticle,

      title: title.trim(),

      slug:
        title.trim() !== oldArticle.title
          ? uniqueSlug(
              title,
              articles,
              id
            )
          : oldArticle.slug,

      category: category || "Mind",

      excerpt: excerpt || "",

      content: content.trim(),

      published: Boolean(published),

      // Keep the old image if no new image was uploaded.
      image_url:
        image_url
          ? image_url
          : oldArticle.image_url,

      updated_at:
        new Date().toISOString()
    };

    articles[index] = updatedArticle;

    writeArticles(articles);

    res.json(
      sanitizeArticle(updatedArticle)
    );
  }
);

// -------------------------
// DELETE ARTICLE
// -------------------------

app.delete(
  "/api/admin/articles/:id",
  requireAdmin,
  (req, res) => {
    const id = Number(req.params.id);

    const articles = readArticles();

    const article = articles.find(
      article => article.id === id
    );

    if (!article) {
      return res.status(404).json({
        error: "Article not found"
      });
    }

    const remainingArticles =
      articles.filter(
        article => article.id !== id
      );

    writeArticles(remainingArticles);

    // Delete uploaded image too.
    if (
      article.image_url &&
      article.image_url.startsWith("/uploads/")
    ) {
      const filename =
        path.basename(article.image_url);

      const imagePath =
        path.join(
          UPLOADS_DIR,
          filename
        );

      if (fs.existsSync(imagePath)) {
        fs.unlinkSync(imagePath);
      }
    }

    res.json({
      ok: true
    });
  }
);

// -------------------------
// ERROR HANDLER
// -------------------------

app.use(
  (error, req, res, next) => {
    console.error(error);

    if (error instanceof multer.MulterError) {
      return res.status(400).json({
        error: error.message
      });
    }

    if (error) {
      return res.status(400).json({
        error:
          error.message ||
          "Something went wrong"
      });
    }

    next();
  }
);

// -------------------------
// START SERVER
// -------------------------

app.listen(PORT, () => {
  console.log(
    `Blog running at http://localhost:${PORT}`
  );
});