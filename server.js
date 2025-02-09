const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const app = express();
const port = 44341;

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(session({
  secret: 'geheimes_schluesselwort',
  resave: false,
  saveUninitialized: false
}));

if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads');
}

const dbFile = 'db.sqlite3';
const db = new sqlite3.Database(dbFile);

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password TEXT,
    role TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT,
    uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    image_id INTEGER,
    user_id INTEGER,
    comment TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(image_id) REFERENCES images(id),
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`);
  db.get("SELECT COUNT(*) as count FROM users", (err, row) => {
    if (row.count === 0) {
      const insert = db.prepare("INSERT INTO users (username, password, role) VALUES (?, ?, ?)");
      insert.run("admin", "admin", "admin");
      insert.run("redakteur", "redakteur", "redakteur");
      insert.finalize();
    }
  });
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => { cb(null, 'uploads/'); },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({ storage: storage });

function isAuthenticated(req, res, next) {
  if (req.session && req.session.user) {
    next();
  } else {
    res.status(401).send("Nicht autorisiert");
  }
}

function hasRole(role) {
  return (req, res, next) => {
    if (req.session && req.session.user && req.session.user.role === role) {
      next();
    } else {
      res.status(403).send("Zugriff verweigert");
    }
  }
}

app.post('/login', (req, res) => {
	const { username, password } = req.body;
	db.get("SELECT * FROM users WHERE username = ? AND password = ?", [username, password], (err, row) => {
	  if (err) {
		res.status(500).json({ error: "Datenbankfehler" });
	  } else if (row) {
		req.session.user = row;
		res.json({ message: "Erfolgreich eingeloggt", user: row });
	  } else {
		res.status(401).json({ error: "Falsche Zugangsdaten" });
	  }
	});
  });
  

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.send("Abgemeldet");
});

app.post('/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    res.status(400).send("Fehlende Felder");
    return;
  }
  db.run("INSERT INTO users (username, password, role) VALUES (?, ?, ?)", [username, password, "benutzer"], function (err) {
    if (err) {
      res.status(500).send("Fehler beim Registrieren: " + err.message);
    } else {
      res.json({ id: this.lastID, username, role: "benutzer" });
    }
  });
});

// Endpoints für die Benutzerverwaltung (nur Admin)
app.get('/users', isAuthenticated, hasRole('admin'), (req, res) => {
  db.all("SELECT id, username, role FROM users", (err, rows) => {
    if (err) {
      res.status(500).send("Fehler beim Abrufen der Benutzer");
    } else {
      res.json(rows);
    }
  });
});

app.put('/users/:id', isAuthenticated, hasRole('admin'), (req, res) => {
  const id = req.params.id;
  const { role } = req.body;
  db.run("UPDATE users SET role = ? WHERE id = ?", [role, id], function(err) {
    if (err) {
      res.status(500).send("Fehler beim Aktualisieren des Benutzers");
    } else {
      res.send("Benutzerrolle aktualisiert");
    }
  });
});

app.post('/users', isAuthenticated, hasRole('admin'), (req, res) => {
  const { username, password, role } = req.body;
  db.run("INSERT INTO users (username, password, role) VALUES (?, ?, ?)", [username, password, role], function (err) {
    if (err) {
      res.status(500).send("Fehler beim Anlegen des Benutzers: " + err.message);
    } else {
      res.json({ id: this.lastID, username, role });
    }
  });
});

// Endpoints für Bilder
app.get('/images', isAuthenticated, (req, res) => {
  db.all("SELECT * FROM images", (err, rows) => {
    if (err) {
      res.status(500).send("Fehler beim Abrufen der Bilder");
    } else {
      res.json(rows);
    }
  });
});

app.post('/upload', isAuthenticated, (req, res, next) => {
	if (req.session.user.role === "admin" || req.session.user.role === "redakteur") {
	  next();
	} else {
	  res.status(403).send("Zugriff verweigert");
	}
  }, upload.single('image'), (req, res) => {
	const filename = req.file.filename;
	db.run("INSERT INTO images (filename) VALUES (?)", [filename], function (err) {
	  if (err) {
		res.status(500).send("Fehler beim Speichern des Bildes in der Datenbank");
	  } else {
		res.json({ id: this.lastID, filename });
	  }
	});
  });
  

app.delete('/images/:id', isAuthenticated, hasRole('admin'), (req, res) => {
  const id = req.params.id;
  db.get("SELECT filename FROM images WHERE id = ?", [id], (err, row) => {
    if (err || !row) {
      res.status(500).send("Bild nicht gefunden");
    } else {
      const filepath = path.join('uploads', row.filename);
      fs.unlink(filepath, (err) => {
        if (err) {
          res.status(500).send("Fehler beim Löschen der Datei");
        } else {
          db.run("DELETE FROM images WHERE id = ?", [id], (err) => {
            if (err) {
              res.status(500).send("Fehler beim Löschen des Bilddatensatzes");
            } else {
              res.send("Bild gelöscht");
            }
          });
        }
      });
    }
  });
});

// Endpoints für Kommentare
app.get('/comments', isAuthenticated, (req, res) => {
  const imageId = req.query.imageId;
  if (!imageId) {
    res.status(400).send("imageId Parameter fehlt");
    return;
  }
  db.all("SELECT c.id, c.comment, c.created_at, u.username FROM comments c JOIN users u ON c.user_id = u.id WHERE c.image_id = ? ORDER BY c.created_at ASC", [imageId], (err, rows) => {
    if (err) {
      res.status(500).send("Fehler beim Abrufen der Kommentare");
    } else {
      res.json(rows);
    }
  });
});

app.post('/comments', isAuthenticated, (req, res) => {
  const { imageId, comment } = req.body;
  if (!imageId || !comment) {
    res.status(400).send("Fehlende Parameter");
    return;
  }
  db.run("INSERT INTO comments (image_id, user_id, comment) VALUES (?, ?, ?)", [imageId, req.session.user.id, comment], function(err) {
    if (err) {
      res.status(500).send("Fehler beim Speichern des Kommentars");
    } else {
      res.json({ id: this.lastID, imageId, userId: req.session.user.id, comment });
    }
  });
});

app.delete('/comments/:id', isAuthenticated, (req, res) => {
  const commentId = req.params.id;
  db.get("SELECT user_id FROM comments WHERE id = ?", [commentId], (err, row) => {
    if (err || !row) {
      res.status(500).send("Kommentar nicht gefunden");
    } else if (req.session.user.id !== row.user_id && req.session.user.role !== 'admin') {
      res.status(403).send("Zugriff verweigert");
    } else {
      db.run("DELETE FROM comments WHERE id = ?", [commentId], function(err) {
        if (err) {
          res.status(500).send("Fehler beim Löschen des Kommentars");
        } else {
          res.send("Kommentar gelöscht");
        }
      });
    }
  });
});

app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

app.listen(port, () => {
  console.log(`CMS läuft unter http://localhost:${port}`);
});
