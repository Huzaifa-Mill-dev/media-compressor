/* ─── Media Compressor — Frontend Logic (v2.1: Side-by-Side & Persistent Results) ─── */

(() => {
  // ─── DOM References ────────────────────────────────────────────────────────
  const dropZone = document.getElementById("drop-zone");
  const fileInput = document.getElementById("file-input");
  const fileInfo = document.getElementById("file-info");
  const fileListBody = document.getElementById("file-list-body");
  const clearFileBtn = document.getElementById("clear-file");

  const optionsSection = document.getElementById("options-section");
  const imageOptions = document.getElementById("image-options");
  const videoOptions = document.getElementById("video-options");
  const videoProfilePills = document.getElementById("video-profile-pills");
  const customVideoDrawer = document.getElementById("custom-video-drawer");

  const stripAudioCheckbox = document.getElementById("strip-audio");
  const imgSrcsetCheckbox = document.getElementById("img-srcset");

  const imgFormat = document.getElementById("img-format");
  const imgQuality = document.getElementById("img-quality");
  const imgQualityVal = document.getElementById("img-quality-val");
  const imgWidth = document.getElementById("img-width");
  const imgHeight = document.getElementById("img-height");

  const vidFormat = document.getElementById("vid-format");
  const vidCodec = document.getElementById("vid-codec");
  const vidCrf = document.getElementById("vid-crf");
  const vidCrfVal = document.getElementById("vid-crf-val");
  const vidResolution = document.getElementById("vid-resolution");
  const vidAudio = document.getElementById("vid-audio");

  const compressBtn = document.getElementById("compress-btn");
  const btnText = compressBtn.querySelector(".btn-text");
  const btnLoader = compressBtn.querySelector(".btn-loader");

  const progressSection = document.getElementById("progress-section");
  const progressFill = document.getElementById("progress-fill");
  const progressText = document.getElementById("progress-text");

  const resultsSection = document.getElementById("results-section");
  const resultsContainer = document.getElementById("results-container");
  const newBtn = document.getElementById("new-btn");
  const clearResultsBtn = document.getElementById("clear-results-btn");
  const downloadAllBtn = document.getElementById("download-all-btn");

  const statsText = document.getElementById("stats-text");

  // Modal references
  const videoModal = document.getElementById("video-modal");
  const modalBackdrop = document.getElementById("modal-backdrop");
  const modalCloseBtn = document.getElementById("modal-close-btn");
  const modalOrigVideo = document.getElementById("modal-orig-video");
  const modalCompVideo = document.getElementById("modal-comp-video");
  const modalVideoTitle = document.getElementById("modal-video-title");
  const modalVideoDims = document.getElementById("modal-video-dims");
  const modalSyncPlayBtn = document.getElementById("modal-sync-play-btn");

  // ─── State ────────────────────────────────────────────────────────────────
  let selectedFiles = []; // Array of { id, file, type, status, url }
  let nextFileId = 1;
  let isCompressing = false;
  let activeVideoProfile = "quality-safe";
  let completedDownloads = [];

  // ─── Formatting Helpers ───────────────────────────────────────────────────
  function formatSize(bytes) {
    if (!bytes || bytes === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + " " + units[i];
  }

  function show(el) { if (el) el.classList.remove("hidden"); }
  function hide(el) { if (el) el.classList.add("hidden"); }

  // ─── History & Stats Fetcher ──────────────────────────────────────────────
  async function loadTeamStats() {
    try {
      const res = await fetch("/api/history");
      if (res.ok) {
        const data = await res.json();
        const saved = formatSize(data.totalSavedBytes || 0);
        const count = data.totalJobs || 0;
        statsText.textContent = `${saved} Saved Across ${count} Jobs`;

      // Render history table
      const historyTableBody = document.getElementById("history-table-body");
      const historyCountBadge = document.getElementById("history-count-badge");
      if (historyTableBody && data.items) {
        if (historyCountBadge) historyCountBadge.textContent = `${data.items.length} entries`;
        historyTableBody.innerHTML = "";
        data.items.forEach((item) => {
          const tr = document.createElement("tr");
          const dateStr = item.timestamp ? new Date(item.timestamp).toLocaleString() : "Recent";
          const profileBadgeClass = item.profile === "av1" ? "purple" : item.profile === "quality-safe" ? "green" : "blue";
          tr.innerHTML = `
            <td style="font-weight:600; color:var(--text);">${item.originalName}</td>
            <td><span class="pill-badge ${profileBadgeClass}" style="position:static; display:inline-block;">${item.profile || "standard"}</span></td>
            <td>${formatSize(item.originalSize)}</td>
            <td style="color:var(--green); font-weight:600;">${formatSize(item.compressedSize)}</td>
            <td style="color:var(--green); font-weight:700;">-${item.savings}%</td>
            <td>${item.qualityScore ? `${item.qualityScore} / 100` : "—"}</td>
            <td style="color:var(--text-dim); font-size:0.75rem;">${dateStr}</td>
          `;
          historyTableBody.appendChild(tr);
        });
      }

      } else {
        statsText.textContent = "Self-Hosted & Active";
      }
    } catch (e) {
      statsText.textContent = "Ready to Compress";
    }
  }
  loadTeamStats();

  // ─── Profile Pills Handler ────────────────────────────────────────────────
  videoProfilePills.querySelectorAll(".profile-pill").forEach((pill) => {
    pill.addEventListener("click", () => {
      videoProfilePills.querySelectorAll(".profile-pill").forEach((p) => p.classList.remove("active"));
      pill.classList.add("active");
      activeVideoProfile = pill.dataset.profile;

      if (activeVideoProfile === "custom") {
        show(customVideoDrawer);
      } else {
        hide(customVideoDrawer);
      }
    });
  });

  // Range sliders input sync
  imgQuality.addEventListener("input", () => { imgQualityVal.textContent = imgQuality.value; });
  vidCrf.addEventListener("input", () => { vidCrfVal.textContent = vidCrf.value; });

  // ─── Drag & Drop / File Input ─────────────────────────────────────────────
  dropZone.addEventListener("click", () => fileInput.click());

  dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.classList.add("drag-over");
  });
  dropZone.addEventListener("dragleave", (e) => {
    e.preventDefault();
    dropZone.classList.remove("drag-over");
  });
  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("drag-over");
    handleFiles(e.dataTransfer.files);
  });

  fileInput.addEventListener("change", () => {
    handleFiles(fileInput.files);
    fileInput.value = "";
  });

  // Clipboard Paste Support (Cmd+V / Ctrl+V)
  window.addEventListener("paste", (e) => {
    if (e.clipboardData && e.clipboardData.files && e.clipboardData.files.length > 0) {
      handleFiles(e.clipboardData.files);
    }
  });

  clearFileBtn.addEventListener("click", clearPendingFiles);

  // ─── Handle File Selection ────────────────────────────────────────────────
  function handleFiles(fileList) {
    const newFiles = Array.from(fileList);

    if (selectedFiles.length + newFiles.length > 10) {
      alert("You can select up to 10 files in a single batch.");
      return;
    }

    newFiles.forEach((file) => {
      const mime = file.type || "";
      let type = null;
      if (mime.startsWith("image/") || /\.(png|jpe?g|webp|avif|gif|tiff)$/i.test(file.name)) {
        type = "image";
      } else if (mime.startsWith("video/") || /\.(mp4|mov|webm|mkv|avi)$/i.test(file.name)) {
        type = "video";
      } else {
        return; // unsupported
      }

      selectedFiles.push({
        id: nextFileId++,
        file,
        type,
        status: "pending",
        url: URL.createObjectURL(file),
      });
    });

    if (selectedFiles.length > 0) {
      renderFileList();
      updateOptionsVisibility();
      show(fileInfo);
      show(optionsSection);
    }
  }

  function renderFileList() {
    fileListBody.innerHTML = "";
    selectedFiles.forEach((item) => {
      const tr = document.createElement("tr");

      let thumbHtml = "";
      if (item.type === "image") {
        thumbHtml = `<img src="${item.url}" alt="thumb">`;
      } else {
        thumbHtml = `<video src="${item.url}#t=0.5" muted playsinline></video>`;
      }

      let statusBadge = "";
      switch (item.status) {
        case "pending":
          statusBadge = `<span class="status-badge pending">Pending</span>`;
          break;
        case "processing":
          statusBadge = `<span class="status-badge processing">Processing…</span>`;
          break;
        case "done":
          statusBadge = `<span class="status-badge done">Done</span>`;
          break;
        case "error":
          statusBadge = `<span class="status-badge error" title="${item.error || "Error"}">Error</span>`;
          break;
      }

      let actionsHtml = "";
      if (!isCompressing) {
        if (item.status === "error") {
          actionsHtml += `<button class="btn-icon retry" onclick="retryFile(${item.id})" title="Retry">↺</button>`;
        }
        if (item.status === "pending" || item.status === "error") {
          actionsHtml += `<button class="btn-icon" onclick="removeFile(${item.id})" title="Remove">✕</button>`;
        }
      }

      tr.innerHTML = `
        <td>
          <div style="display:flex; align-items:center; gap:0.75rem;">
            <div class="table-thumb">${thumbHtml}</div>
            <div class="file-name-cell" title="${item.file.name}">${item.file.name}</div>
          </div>
        </td>
        <td>${item.type === "image" ? "Image" : "Video"}</td>
        <td style="color:var(--text-dim)">${formatSize(item.file.size)}</td>
        <td>${statusBadge}</td>
        <td style="text-align:right;">${actionsHtml}</td>
      `;
      fileListBody.appendChild(tr);
    });
  }

  function updateOptionsVisibility() {
    const hasImages = selectedFiles.some((f) => f.type === "image");
    const hasVideos = selectedFiles.some((f) => f.type === "video");

    if (hasImages) show(imageOptions);
    else hide(imageOptions);
    if (hasVideos) show(videoOptions);
    else hide(videoOptions);
  }

  window.removeFile = (id) => {
    selectedFiles = selectedFiles.filter((f) => f.id !== id);
    if (selectedFiles.length === 0) {
      clearPendingFiles();
    } else {
      renderFileList();
      updateOptionsVisibility();
    }
  };

  window.retryFile = (id) => {
    const item = selectedFiles.find((f) => f.id === id);
    if (item) {
      item.status = "pending";
      item.error = null;
      renderFileList();
    }
  };

  function clearPendingFiles() {
    selectedFiles.forEach((f) => {
      // Don't revoke URL if it's already shown in a result card
    });
    selectedFiles = [];
    fileInput.value = "";
    fileListBody.innerHTML = "";
    hide(fileInfo);
    hide(optionsSection);
    hide(imageOptions);
    hide(videoOptions);
    hide(progressSection);
  }

  // ─── Compression Execution ────────────────────────────────────────────────
  compressBtn.addEventListener("click", async () => {
    const pendingItems = selectedFiles.filter((f) => f.status === "pending");
    if (pendingItems.length === 0) return;

    isCompressing = true;
    hide(btnText);
    show(btnLoader);
    compressBtn.disabled = true;
    clearFileBtn.disabled = true;

    show(progressSection);
    show(resultsSection);

    const totalCount = pendingItems.length;
    let processedCount = 0;

    for (const item of pendingItems) {
      item.status = "processing";
      renderFileList();

      const pct = Math.round((processedCount / totalCount) * 100);
      progressFill.style.width = `${pct}%`;
      progressText.textContent = `Optimizing ${item.file.name} (${processedCount + 1} of ${totalCount})…`;

      // Build options payload
      const options = {};
      if (item.type === "image") {
        options.format = imgFormat.value;
        options.quality = parseInt(imgQuality.value);
        if (imgWidth.value) options.width = parseInt(imgWidth.value);
        if (imgHeight.value) options.height = parseInt(imgHeight.value);
        options.exportSrcset = imgSrcsetCheckbox.checked;
      } else {
        options.profile = activeVideoProfile;
        options.stripAudio = stripAudioCheckbox.checked;

        if (activeVideoProfile === "custom") {
          options.format = vidFormat.value;
          options.codec = vidCodec.value;
          options.crf = parseInt(vidCrf.value);
          options.resolution = vidResolution.value;
          options.audioBitrate = vidAudio.value;
        }
      }

      const formData = new FormData();
      formData.append("file", item.file);
      formData.append("options", JSON.stringify(options));

      try {
        const response = await fetch("/api/compress", {
          method: "POST",
          body: formData,
        });

        if (!response.ok) {
          const errData = await response.json().catch(() => ({}));
          throw new Error(errData.error || `HTTP error ${response.status}`);
        }

        const data = await response.json();
        item.status = "done";
        completedDownloads.push({ name: data.filename, url: data.downloadUrl });
        appendResultCard(data, item.url);
      } catch (err) {
        console.error(err);
        item.status = "error";
        item.error = err.message;
      }

      processedCount++;
      renderFileList();
    }

    progressFill.style.width = "100%";
    progressText.textContent = "All complete!";

    isCompressing = false;
    show(btnText);
    hide(btnLoader);
    compressBtn.disabled = false;
    clearFileBtn.disabled = false;
    renderFileList();

    if (completedDownloads.length > 1) {
      show(downloadAllBtn);
    }
    setTimeout(() => hide(progressSection), 2000);
    loadTeamStats();
  });

  // ─── Download All Button ──────────────────────────────────────────────────
  downloadAllBtn.addEventListener("click", () => {
    completedDownloads.forEach((item, i) => {
      setTimeout(() => {
        const a = document.createElement("a");
        a.href = item.url;
        a.download = item.name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      }, i * 350);
    });
  });

  // ─── Render Result Card (Side-by-Side) ────────────────────────────────────
  function appendResultCard(data, originalUrl) {
    const savings = data.savings;
    const savingsColor = savings > 0 ? "var(--green)" : "var(--red)";
    const savingsBg = savings > 0 ? "var(--green-glow)" : "rgba(239, 68, 68, 0.1)";
    const savingsText = savings > 0 ? `-${savings}%` : `+${Math.abs(savings)}%`;

    const cardId = `item-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const dimsText = `${data.outputWidth || data.originalWidth}×${data.outputHeight || data.originalHeight}`;

    // Quality Score Badge
    let qualityBadgeHtml = "";
    if (data.qualityScore) {
      qualityBadgeHtml = `
        <div class="quality-score-badge lossless">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
          <span>Score: ${data.qualityScore.score} · ${data.qualityScore.label}</span>
        </div>
      `;
    }

    // Media Side-by-Side Component
    let sideBySideHtml = "";
    if (data.type === "image") {
      sideBySideHtml = `
        <div class="side-by-side-preview">
          <div class="side-player-card">
            <div class="side-player-header">
              <span class="label-orig">Original</span>
              <span>${formatSize(data.originalSize)} · ${data.originalWidth}×${data.originalHeight}</span>
            </div>
            <div class="side-player-body image-box">
              <img src="${originalUrl}" alt="Original Image" />
            </div>
          </div>
          <div class="side-player-card">
            <div class="side-player-header">
              <span class="label-comp">Compressed</span>
              <span>${formatSize(data.compressedSize)} · ${data.outputWidth || data.originalWidth}×${data.outputHeight || data.originalHeight}</span>
            </div>
            <div class="side-player-body image-box">
              <img src="${data.previewUrl}" alt="Compressed Image" />
            </div>
          </div>
        </div>
      `;
    } else {
      // Side-by-Side Synchronized Videos
      sideBySideHtml = `
        <div class="side-by-side-preview">
          <div class="side-player-card">
            <div class="side-player-header">
              <span class="label-orig">Original Source</span>
              <span>${formatSize(data.originalSize)} · ${data.originalWidth}×${data.originalHeight}</span>
            </div>
            <div class="side-player-body">
              <video id="orig-vid-${cardId}" src="${originalUrl}" controls playsinline muted></video>
            </div>
          </div>
          <div class="side-player-card">
            <div class="side-player-header">
              <span class="label-comp">Compressed</span>
              <span>${formatSize(data.compressedSize)} · ${data.outputWidth}×${data.outputHeight}</span>
            </div>
            <div class="side-player-body">
              <video id="comp-vid-${cardId}" src="${data.previewUrl}" controls playsinline ${data.posterUrl ? `poster="${data.posterUrl}"` : ""}></video>
            </div>
          </div>
        </div>
        <div class="preview-actions-bar">
          <button type="button" class="btn-sync-play" onclick="toggleSyncPlay('${cardId}')">
            ▶ Play / Pause Both in Sync
          </button>
          <button type="button" class="btn-expand-preview" onclick="openFullscreenSideBySide('${data.originalName}', '${originalUrl}', '${data.previewUrl}', '${dimsText}')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="15 3 21 3 21 9"></polyline>
              <polyline points="9 21 3 21 3 15"></polyline>
              <line x1="21" y1="3" x2="14" y2="10"></line>
              <line x1="3" y1="21" x2="10" y2="14"></line>
            </svg>
            <span>⛶ Fullscreen Comparison</span>
          </button>
        </div>
      `;
    }

    const detailRows = [
      ["Original Size", formatSize(data.originalSize)],
      ["Compressed Size", formatSize(data.compressedSize)],
      ["Dimensions", `${data.outputWidth || data.originalWidth} × ${data.outputHeight || data.originalHeight}`],
      ["Output Profile/Codec", data.profile || data.outputCodec || data.outputFormat || "—"],
    ];

    let detailsTableHtml = "";
    detailRows.forEach(([l, v]) => {
      detailsTableHtml += `<tr><td>${l}</td><td>${v}</td></tr>`;
    });

    if (data.srcset && data.srcset.length > 0) {
      detailsTableHtml += `<tr><td colspan="2" style="font-weight:600; padding-top:0.75rem;">Responsive srcset generated:</td></tr>`;
      data.srcset.forEach((s) => {
        detailsTableHtml += `<tr><td>${s.width}w (${formatSize(s.size)})</td><td><a href="${s.downloadUrl}" download="${s.filename}" style="color:var(--primary-hover)">Download</a></td></tr>`;
      });
    }

    const card = document.createElement("div");
    card.className = "result-item";
    card.innerHTML = `
      <div class="result-header">
        <div class="result-filename">${data.originalName} &rarr; ${data.filename}</div>
        <div style="display:flex; align-items:center; gap:0.6rem;">
          ${qualityBadgeHtml}
          <a href="${data.downloadUrl}" download="${data.filename}" class="btn-download" style="padding: 0.4rem 0.8rem; font-size: 0.8rem; flex: 0 0 auto;">Download</a>
        </div>
      </div>

      <div class="stats-row" style="margin-bottom: 1rem;">
        <div class="stat-card">
          <p class="stat-label">Original</p>
          <p class="stat-value">${formatSize(data.originalSize)}</p>
        </div>
        <div class="stat-card stat-arrow">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline>
          </svg>
        </div>
        <div class="stat-card">
          <p class="stat-label">Compressed</p>
          <p class="stat-value">${formatSize(data.compressedSize)}</p>
        </div>
        <div class="stat-card" style="border-color:${savingsColor}; background:${savingsBg}">
          <p class="stat-label">Savings</p>
          <p class="stat-value" style="color:${savingsColor}">${savingsText}</p>
        </div>
      </div>

      <div style="margin-bottom: 1rem;">
        ${sideBySideHtml}
      </div>

      <button class="btn-details" onclick="document.getElementById('details-${cardId}').classList.toggle('hidden'); this.classList.toggle('open');">
        <span>Toggle Technical Details</span>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="6 9 12 15 18 9"></polyline>
        </svg>
      </button>
      <div id="details-${cardId}" class="details-panel hidden">
        <table class="details-table">
          <tbody>${detailsTableHtml}</tbody>
        </table>
      </div>
    `;

    resultsContainer.appendChild(card);

    // Setup Video Synchronization between the two players
    if (data.type === "video") {
      const origV = card.querySelector(`#orig-vid-${cardId}`);
      const compV = card.querySelector(`#comp-vid-${cardId}`);
      if (origV && compV) {
        let isSyncing = false;
        origV.addEventListener("play", () => {
          if (!isSyncing && compV.paused) {
            isSyncing = true;
            compV.currentTime = origV.currentTime;
            compV.play().catch(() => {});
            setTimeout(() => (isSyncing = false), 150);
          }
        });
        origV.addEventListener("pause", () => {
          if (!isSyncing && !compV.paused) {
            isSyncing = true;
            compV.pause();
            setTimeout(() => (isSyncing = false), 150);
          }
        });
        origV.addEventListener("seeked", () => {
          if (Math.abs(compV.currentTime - origV.currentTime) > 0.1) {
            compV.currentTime = origV.currentTime;
          }
        });

        compV.addEventListener("play", () => {
          if (!isSyncing && origV.paused) {
            isSyncing = true;
            origV.currentTime = compV.currentTime;
            origV.play().catch(() => {});
            setTimeout(() => (isSyncing = false), 150);
          }
        });
        compV.addEventListener("pause", () => {
          if (!isSyncing && !origV.paused) {
            isSyncing = true;
            origV.pause();
            setTimeout(() => (isSyncing = false), 150);
          }
        });
        compV.addEventListener("seeked", () => {
          if (Math.abs(origV.currentTime - compV.currentTime) > 0.1) {
            origV.currentTime = compV.currentTime;
          }
        });
      }
    }

    card.scrollIntoView({ behavior: "smooth", block: "end" });
  }

  // ─── Play / Pause Both in Sync ────────────────────────────────────────────
  window.toggleSyncPlay = (cardId) => {
    const orig = document.getElementById(`orig-vid-${cardId}`);
    const comp = document.getElementById(`comp-vid-${cardId}`);
    if (!orig || !comp) return;

    if (orig.paused || comp.paused) {
      comp.currentTime = orig.currentTime;
      orig.play().catch(() => {});
      comp.play().catch(() => {});
    } else {
      orig.pause();
      comp.pause();
    }
  };

  // ─── Side-by-Side Fullscreen Modal Logic ──────────────────────────────────
  window.openFullscreenSideBySide = (title, origUrl, compUrl, dims) => {
    modalVideoTitle.textContent = title;
    modalVideoDims.textContent = dims;
    modalOrigVideo.src = origUrl;
    modalCompVideo.src = compUrl;

    show(videoModal);
    videoModal.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";

    // Synchronize modal videos
    modalOrigVideo.currentTime = 0;
    modalCompVideo.currentTime = 0;
    modalOrigVideo.play().catch(() => {});
    modalCompVideo.play().catch(() => {});
  };

  modalSyncPlayBtn.addEventListener("click", () => {
    if (modalOrigVideo.paused || modalCompVideo.paused) {
      modalCompVideo.currentTime = modalOrigVideo.currentTime;
      modalOrigVideo.play().catch(() => {});
      modalCompVideo.play().catch(() => {});
      modalSyncPlayBtn.textContent = "⏸ Pause Both";
    } else {
      modalOrigVideo.pause();
      modalCompVideo.pause();
      modalSyncPlayBtn.textContent = "▶ Play Both in Sync";
    }
  });

  
  // ─── Modal Two-Way Video Synchronization ─────────────────────────────────
  let isModalSyncing = false;

  modalOrigVideo.addEventListener("play", () => {
    if (!isModalSyncing && modalCompVideo.paused) {
      isModalSyncing = true;
      modalCompVideo.currentTime = modalOrigVideo.currentTime;
      modalCompVideo.play().catch(() => {});
      modalSyncPlayBtn.textContent = "⏸ Pause Both";
      setTimeout(() => (isModalSyncing = false), 150);
    }
  });

  modalOrigVideo.addEventListener("pause", () => {
    if (!isModalSyncing && !modalCompVideo.paused) {
      isModalSyncing = true;
      modalCompVideo.pause();
      modalSyncPlayBtn.textContent = "▶ Play Both in Sync";
      setTimeout(() => (isModalSyncing = false), 150);
    }
  });

  modalOrigVideo.addEventListener("seeked", () => {
    if (Math.abs(modalCompVideo.currentTime - modalOrigVideo.currentTime) > 0.1) {
      modalCompVideo.currentTime = modalOrigVideo.currentTime;
    }
  });

  modalCompVideo.addEventListener("play", () => {
    if (!isModalSyncing && modalOrigVideo.paused) {
      isModalSyncing = true;
      modalOrigVideo.currentTime = modalCompVideo.currentTime;
      modalOrigVideo.play().catch(() => {});
      modalSyncPlayBtn.textContent = "⏸ Pause Both";
      setTimeout(() => (isModalSyncing = false), 150);
    }
  });

  modalCompVideo.addEventListener("pause", () => {
    if (!isModalSyncing && !modalOrigVideo.paused) {
      isModalSyncing = true;
      modalOrigVideo.pause();
      modalSyncPlayBtn.textContent = "▶ Play Both in Sync";
      setTimeout(() => (isModalSyncing = false), 150);
    }
  });

  modalCompVideo.addEventListener("seeked", () => {
    if (Math.abs(modalOrigVideo.currentTime - modalCompVideo.currentTime) > 0.1) {
      modalOrigVideo.currentTime = modalCompVideo.currentTime;
    }
  });

  window.openFullscreenModal = window.openFullscreenSideBySide;

  function closeFullscreenModal() {
    modalOrigVideo.pause();
    modalCompVideo.pause();
    modalOrigVideo.src = "";
    modalCompVideo.src = "";
    hide(videoModal);
    videoModal.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
    modalSyncPlayBtn.textContent = "▶ Play Both in Sync";
  }

  modalCloseBtn.addEventListener("click", closeFullscreenModal);
  modalBackdrop.addEventListener("click", closeFullscreenModal);

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !videoModal.classList.contains("hidden")) {
      closeFullscreenModal();
    }
  });

  // ─── Compress More (Keeps Previous Results!) ──────────────────────────────
  newBtn.addEventListener("click", () => {
    // Clear only current file selection and upload queue
    selectedFiles = [];
    fileInput.value = "";
    fileListBody.innerHTML = "";
    hide(fileInfo);
    hide(optionsSection);
    hide(imageOptions);
    hide(videoOptions);
    hide(progressSection);

    // RESULTS ARE KEPT!
    dropZone.scrollIntoView({ behavior: "smooth", block: "center" });
  });

  // ─── Clear All Results ────────────────────────────────────────────────────
  clearResultsBtn.addEventListener("click", () => {
    resultsContainer.innerHTML = "";
    hide(resultsSection);
    hide(downloadAllBtn);
    completedDownloads = [];
  });
})();
