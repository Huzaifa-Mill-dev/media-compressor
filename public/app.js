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
  const progressStageTitle = document.getElementById("progress-stage-title");
  const progressTimer = document.getElementById("progress-timer");
  const progressPercent = document.getElementById("progress-percent");
  const progressSubtext = document.getElementById("progress-subtext");

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

  // Warning Modal references
  const warningModal = document.getElementById("warning-modal");
  const warningModalBackdrop = document.getElementById("warning-modal-backdrop");
  const warningModalDesc = document.getElementById("warning-modal-desc");
  const warningCloseBtn = document.getElementById("warning-close-btn");
  const warningContinueBtn = document.getElementById("warning-continue-btn");
  const warningAbortBtn = document.getElementById("warning-abort-btn");

  // ─── State ────────────────────────────────────────────────────────────────
  let selectedFiles = []; // Array of { id, file, type, status, url }
  let nextFileId = 1;
  let isCompressing = false;
  let currentAbortController = null;
  let progressInterval = null;
  let pendingAbortAction = null;
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
  dropZone.addEventListener("click", () => {
    if (isCompressing) {
      showWarningModal(() => {
        fileInput.click();
      }, "A media compression task is actively running. Selecting new files now will cancel the current job.");
      return;
    }
    fileInput.click();
  });

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

  clearFileBtn.addEventListener("click", () => {
    if (isCompressing) {
      showWarningModal(() => {
        clearPendingFiles();
      }, "A compression task is actively running. Clearing selected files will cancel the active job.");
      return;
    }
    clearPendingFiles();
  });

  // ─── Handle File Selection ────────────────────────────────────────────────
  function handleFiles(fileList) {
    if (isCompressing) {
      showWarningModal(() => {
        handleFiles(fileList);
      }, "A compression task is actively running. Adding new files now will cancel the active job.");
      return;
    }

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
          statusBadge = `
            <div class="status-error-container">
              <span class="status-badge error">Failed</span>
              <p class="status-error-text">${item.error || "Compression failed"}</p>
            </div>
          `;
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

  // ─── Unload / Refresh Guard ────────────────────────────────────────────────
  window.addEventListener("beforeunload", (e) => {
    if (isCompressing) {
      e.preventDefault();
      e.returnValue = "A media compression job is currently running. Leaving or reloading now will abort the process and you may lose your results.";
      return e.returnValue;
    }
  });

  // ─── Interrupt Warning Modal ──────────────────────────────────────────────
  function showWarningModal(onAbortAction, customMessage) {
    pendingAbortAction = onAbortAction;
    if (customMessage && warningModalDesc) {
      warningModalDesc.textContent = customMessage;
    } else if (warningModalDesc) {
      warningModalDesc.textContent =
        "Interrupting or navigating away now will cancel the encoding job in progress and you may lose processed data.";
    }
    show(warningModal);
    warningModal.removeAttribute("aria-hidden");
  }

  function closeWarningModal() {
    hide(warningModal);
    warningModal.setAttribute("aria-hidden", "true");
    pendingAbortAction = null;
  }

  if (warningCloseBtn) warningCloseBtn.addEventListener("click", closeWarningModal);
  if (warningModalBackdrop) warningModalBackdrop.addEventListener("click", closeWarningModal);
  if (warningContinueBtn) warningContinueBtn.addEventListener("click", closeWarningModal);

  if (warningAbortBtn) {
    warningAbortBtn.addEventListener("click", () => {
      const action = pendingAbortAction;
      closeWarningModal();
      abortCurrentCompression();
      if (typeof action === "function") {
        action();
      }
    });
  }

  function abortCurrentCompression() {
    if (currentAbortController) {
      try {
        currentAbortController.abort();
      } catch (e) {}
      currentAbortController = null;
    }
    stopProgressSimulation(false);
    isCompressing = false;
    show(btnText);
    hide(btnLoader);
    compressBtn.disabled = false;
    clearFileBtn.disabled = false;
    hide(progressSection);

    selectedFiles.forEach((f) => {
      if (f.status === "processing") {
        f.status = "error";
        f.error = "Cancelled by user";
      }
    });
    renderFileList();
  }

  // ─── Dynamic Progress Tracking & Live Backend Sync ────────────────────────
  let activeEventSource = null;

  function uploadWithProgress(url, formData, jobId, onProgress, abortController) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", url, true);
      if (jobId) {
        xhr.setRequestHeader("X-Job-Id", jobId);
      }

      if (abortController) {
        abortController.signal.addEventListener("abort", () => {
          xhr.abort();
          const err = new Error("AbortError");
          err.name = "AbortError";
          reject(err);
        });
      }

      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && onProgress) {
          onProgress(event.loaded, event.total);
        }
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(JSON.parse(xhr.responseText));
          } catch (e) {
            resolve({});
          }
        } else if (xhr.status === 502 || xhr.status === 503 || xhr.status === 504) {
          reject(new Error("Server restarted or dropped connection during transcode. The cloud instance likely exceeded its 512MB RAM limit. Try using the 'Web Stream' profile."));
        } else {
          try {
            const errData = JSON.parse(xhr.responseText);
            reject(new Error(errData.error || `HTTP error ${xhr.status}`));
          } catch (e) {
            reject(new Error(`HTTP error ${xhr.status}`));
          }
        }
      };

      xhr.onerror = () => {
        reject(new Error("Server connection lost. The server may have restarted due to memory limits."));
      };

      xhr.onabort = () => {
        const err = new Error("AbortError");
        err.name = "AbortError";
        reject(err);
      };

      xhr.send(formData);
    });
  }

  function startProgressSimulation(fileName, fileIndex, totalFiles, isVideo, jobId) {
    const startTime = Date.now();
    let currentPhase = "upload"; // "upload" -> "encode"
    let currentServerPct = 5;
    const basePct = (fileIndex / totalFiles) * 100;
    const slicePct = 100 / totalFiles;

    const initialTotalPct = Math.round(basePct + (2 / 100) * slicePct);
    if (progressFill) progressFill.style.width = `${initialTotalPct}%`;
    if (progressPercent) progressPercent.textContent = `${initialTotalPct}%`;
    if (progressTimer) progressTimer.textContent = "⏱️ 00:00";

    if (progressStageTitle) progressStageTitle.textContent = `Uploading File (${fileIndex + 1}/${totalFiles})…`;
    if (progressText) progressText.textContent = `Uploading "${fileName}" to processing engine…`;
    if (progressSubtext) progressSubtext.textContent = "High-speed streaming upload active";

    if (progressInterval) clearInterval(progressInterval);
    if (activeEventSource) {
      activeEventSource.close();
      activeEventSource = null;
    }

    function applyUpdate(percent, message, stageTitle) {
      currentPhase = "encode";
      if (typeof percent === "number" && percent > currentServerPct) {
        currentServerPct = percent;
      }
      if (message && progressText) {
        progressText.textContent = message;
      }
      if (stageTitle && progressStageTitle) {
        progressStageTitle.textContent = stageTitle;
      } else if (progressStageTitle) {
        progressStageTitle.textContent = isVideo
          ? `Optimizing Video (${fileIndex + 1}/${totalFiles})`
          : `Optimizing Image (${fileIndex + 1}/${totalFiles})`;
      }
      if (progressSubtext) {
        progressSubtext.textContent = isVideo
          ? "Safe low-memory allocation active (CRF 18 · 2 threads)"
          : "Sharp high-efficiency pipeline active";
      }

      // Encode phase maps the real 0% - 100% FFmpeg progress cleanly from 20% to 95%
      const fileProgress = Math.min(96, Math.round(20 + (currentServerPct / 100) * 75));
      const totalPct = Math.min(99, Math.round(basePct + (fileProgress / 100) * slicePct));
      if (progressFill) progressFill.style.width = `${totalPct}%`;
      if (progressPercent) progressPercent.textContent = `${totalPct}%`;
    }

    // Connect to real-time Server-Sent Events stream for zero-latency FFmpeg events
    if (jobId && window.EventSource) {
      try {
        activeEventSource = new EventSource(`/api/progress/${jobId}/stream`);
        activeEventSource.onmessage = (e) => {
          try {
            const data = JSON.parse(e.data);
            if (data.stage && data.stage !== "waiting") {
              applyUpdate(data.percent, data.message);
            }
          } catch (err) {}
        };
        activeEventSource.onerror = () => {
          if (activeEventSource) {
            activeEventSource.close();
            activeEventSource = null;
          }
        };
      } catch (err) {}
    }

    // Timer & continuous smooth progress sync
    let isPolling = false;
    progressInterval = setInterval(async () => {
      const elapsedSec = Math.floor((Date.now() - startTime) / 1000);
      const mins = String(Math.floor(elapsedSec / 60)).padStart(2, "0");
      const secs = String(elapsedSec % 60).padStart(2, "0");
      if (progressTimer) progressTimer.textContent = `⏱️ ${mins}:${secs}`;

      if (currentPhase === "encode") {
        if (jobId && !isPolling) {
          isPolling = true;
          try {
            const res = await fetch(`/api/progress/${jobId}`);
            if (res.ok) {
              const data = await res.json();
              if (data.stage && data.stage !== "waiting") {
                applyUpdate(data.percent, data.message);
              }
            }
          } catch (e) {
          } finally {
            isPolling = false;
          }
        }
      }
    }, 160);

    return {
      onUploadProgress: (loaded, total) => {
        if (currentPhase !== "upload") return;
        const uploadPct = Math.round((loaded / total) * 100);
        // Upload phase maps to 0% to 25% of the file progress
        const fileProgress = Math.round(uploadPct * 0.25);
        if (progressStageTitle) {
          progressStageTitle.textContent = `Uploading File (${fileIndex + 1}/${totalFiles})…`;
        }
        if (progressText) {
          progressText.textContent = `Uploading "${fileName}" (${formatSize(loaded)} / ${formatSize(total)} · ${uploadPct}%)…`;
        }
        if (progressSubtext) {
          progressSubtext.textContent = "Streaming to compression engine…";
        }
        const totalPct = Math.min(99, Math.round(basePct + (fileProgress / 100) * slicePct));
        if (progressFill) progressFill.style.width = `${totalPct}%`;
        if (progressPercent) progressPercent.textContent = `${totalPct}%`;
        if (uploadPct >= 100) {
          currentPhase = "encode";
          if (progressText) progressText.textContent = "Upload complete! Initializing FFmpeg transcode…";
        }
      },
    };
  }

  function stopProgressSimulation(isSuccess = true) {
    if (activeEventSource) {
      activeEventSource.close();
      activeEventSource = null;
    }
    if (progressInterval) {
      clearInterval(progressInterval);
      progressInterval = null;
    }
    if (isSuccess) {
      if (progressFill) progressFill.style.width = "100%";
      if (progressPercent) progressPercent.textContent = "100%";
      if (progressStageTitle) progressStageTitle.textContent = "Optimization Complete";
      if (progressText) progressText.textContent = "All files successfully processed!";
      if (progressSubtext) progressSubtext.textContent = "Ready for synchronized side-by-side inspection";
    }
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
      if (!isCompressing) break;

      item.status = "processing";
      renderFileList();

      const jobId = `job-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
      const tracker = startProgressSimulation(item.file.name, processedCount, totalCount, item.type === "video", jobId);

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
      formData.append("jobId", jobId);

      currentAbortController = new AbortController();

      try {
        const data = await uploadWithProgress(
          "/api/compress",
          formData,
          jobId,
          tracker.onUploadProgress,
          currentAbortController
        );

        item.status = "done";
        completedDownloads.push({ name: data.filename, url: data.downloadUrl });
        appendResultCard(data, item.url);
      } catch (err) {
        if (err.name === "AbortError") {
          console.warn("Compression cancelled by user.");
          item.status = "error";
          item.error = "Cancelled by user";
          appendErrorCard(item.file.name, "Compression was cancelled by user.");
          break;
        } else {
          console.error(err);
          item.status = "error";
          item.error = err.message;
          appendErrorCard(item.file.name, err.message);
        }
      } finally {
        currentAbortController = null;
      }

      processedCount++;
      renderFileList();
    }

    if (isCompressing) {
      stopProgressSimulation(true);
      isCompressing = false;
      show(btnText);
      hide(btnLoader);
      compressBtn.disabled = false;
      clearFileBtn.disabled = false;
      renderFileList();

      if (completedDownloads.length > 1) {
        show(downloadAllBtn);
      }
      setTimeout(() => {
        if (!isCompressing) hide(progressSection);
      }, 4000);
      loadTeamStats();
    }
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

      ${data.savings < 0 ? `
        <div style="background:rgba(239, 68, 68, 0.08); border:1px solid rgba(239, 68, 68, 0.25); border-radius:6px; padding:0.65rem 0.9rem; margin-bottom:1rem; font-size:0.8rem; color:#fca5a5; line-height:1.4;">
          💡 <strong>Notice:</strong> This video was already highly compressed at source (~${formatSize(data.originalSize / (data.duration || 100))}/s). The selected profile targeted higher visual fidelity. Use <strong>⚡ Web Stream</strong> or <strong>🚀 AV1</strong> for maximum file reduction on pre-compressed videos.
        </div>
      ` : ""}

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
    if (isCompressing) {
      showWarningModal(() => {
        doCompressMore();
      }, "A media compression job is currently running. Clicking 'Compress More' now will cancel the active encoding job.");
      return;
    }
    doCompressMore();
  });

  function doCompressMore() {
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
  }

  // ─── Clear All Results ────────────────────────────────────────────────────
  clearResultsBtn.addEventListener("click", () => {
    if (isCompressing) {
      showWarningModal(() => {
        doClearResults();
      }, "A media compression job is currently running. Clearing results now will cancel the active job and remove all output cards.");
      return;
    }
    doClearResults();
  });

  function doClearResults() {
    resultsContainer.innerHTML = "";
    hide(resultsSection);
    hide(downloadAllBtn);
    completedDownloads = [];
  }
})();
