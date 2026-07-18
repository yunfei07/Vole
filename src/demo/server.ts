import http from 'node:http';
import { URLSearchParams } from 'node:url';

const host = '127.0.0.1';
const port = Number(process.env.AI_PW_DEMO_PORT ?? 4173);

function sendHtml(response: http.ServerResponse, html: string, statusCode = 200): void {
  response.writeHead(statusCode, { 'content-type': 'text/html; charset=utf-8' });
  response.end(html);
}

function redirect(response: http.ServerResponse, location: string, headers: Record<string, string> = {}): void {
  response.writeHead(302, { location, ...headers });
  response.end();
}

async function readBody(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function isAuthenticated(request: http.IncomingMessage): boolean {
  return request.headers.cookie?.includes('ai_pw_demo_session=ok') ?? false;
}

function pageShell(title: string, body: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    :root {
      color-scheme: light;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #f5f7fb;
      color: #1f2937;
    }
    body { margin: 0; }
    header {
      height: 56px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 24px;
      background: #ffffff;
      border-bottom: 1px solid #e5e7eb;
      font-weight: 700;
    }
    nav { display: flex; gap: 8px; align-items: center; font-weight: 600; }
    nav a {
      color: #475569;
      text-decoration: none;
      padding: 8px 10px;
      border-radius: 6px;
    }
    nav a[aria-current="page"] { color: #1d4ed8; background: #eff6ff; }
    main { max-width: 1120px; margin: 32px auto; padding: 0 20px; }
    h1 { margin: 0 0 20px; font-size: 24px; }
    label { display: grid; gap: 6px; font-size: 14px; font-weight: 600; }
    input, select, textarea {
      height: 38px;
      border: 1px solid #cbd5e1;
      border-radius: 6px;
      padding: 0 10px;
      font-size: 14px;
      background: #ffffff;
    }
    textarea { height: 84px; padding: 10px; resize: vertical; }
    button {
      height: 38px;
      border: 0;
      border-radius: 6px;
      padding: 0 14px;
      color: #ffffff;
      background: #2563eb;
      font-weight: 700;
      cursor: pointer;
    }
    button.secondary { background: #475569; }
    button.danger { background: #dc2626; }
    .panel {
      background: #ffffff;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      padding: 20px;
      box-shadow: 0 10px 24px rgba(15, 23, 42, 0.06);
    }
    .login { max-width: 360px; margin: 80px auto; display: grid; gap: 16px; }
    .toolbar { display: flex; gap: 12px; align-items: end; margin-bottom: 18px; flex-wrap: wrap; }
    .form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
    .form-grid .full { grid-column: 1 / -1; }
    .tabs { display: flex; gap: 8px; border-bottom: 1px solid #e5e7eb; margin-bottom: 18px; }
    .tab {
      color: #334155;
      background: transparent;
      border-radius: 0;
      border-bottom: 3px solid transparent;
    }
    .tab[aria-selected="true"] { color: #1d4ed8; border-bottom-color: #2563eb; }
    .menu { position: relative; display: inline-block; }
    .menu-list {
      position: absolute;
      right: 0;
      top: 44px;
      min-width: 128px;
      display: none;
      padding: 6px;
      background: #ffffff;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      box-shadow: 0 12px 30px rgba(15, 23, 42, 0.12);
      z-index: 10;
    }
    .menu-list[open] { display: grid; gap: 4px; }
    .menu-list button { justify-content: flex-start; width: 100%; background: #ffffff; color: #1f2937; }
    .toast {
      position: fixed;
      right: 24px;
      bottom: 24px;
      display: none;
      min-width: 220px;
      padding: 12px 14px;
      border-radius: 8px;
      color: #ffffff;
      background: #15803d;
      box-shadow: 0 18px 40px rgba(15, 23, 42, 0.2);
      font-weight: 700;
    }
    .toast[open] { display: block; }
    .error { color: #dc2626; font-size: 13px; font-weight: 700; }
    table { width: 100%; border-collapse: collapse; background: #ffffff; }
    th, td { padding: 12px 14px; border-bottom: 1px solid #e5e7eb; text-align: left; }
    th { color: #475569; font-size: 13px; background: #f8fafc; }
    .status { font-weight: 700; }
    .status.pending { color: #b45309; }
    .status.approved { color: #15803d; }
    dialog {
      border: 0;
      border-radius: 8px;
      width: min(420px, calc(100vw - 40px));
      padding: 0;
      box-shadow: 0 24px 80px rgba(15, 23, 42, 0.28);
    }
    dialog::backdrop { background: rgba(15, 23, 42, 0.38); }
    .dialog-body { padding: 20px; display: grid; gap: 16px; }
    .dialog-actions { display: flex; justify-content: flex-end; gap: 10px; }
  </style>
</head>
<body>
  ${body}
</body>
</html>`;
}

function headerNav(activePath: string): string {
  const items = [
    ['/orders', '订单管理'],
    ['/users', '用户管理'],
    ['/products', '商品管理'],
    ['/settings', '系统设置']
  ];

  return `<header>
  <div>AI Playwright Demo</div>
  <nav aria-label="主导航">
    ${items
      .map(([href, label]) => `<a href="${href}" ${href === activePath ? 'aria-current="page"' : ''}>${label}</a>`)
      .join('')}
  </nav>
</header>`;
}

function loginPage(error = ''): string {
  return pageShell(
    '登录',
    `<main>
  <form class="panel login" method="post" action="/api/login">
    <h1>测试系统登录</h1>
    ${error ? `<p role="alert">${error}</p>` : ''}
    <label>
      用户名
      <input data-testid="username" name="username" autocomplete="username" value="admin" />
    </label>
    <label>
      密码
      <input data-testid="password" name="password" type="password" autocomplete="current-password" value="admin123" />
    </label>
    <button data-testid="login-submit" type="submit">登录</button>
  </form>
</main>`
  );
}

function ordersPage(): string {
  return pageShell(
    '订单管理',
    `${headerNav('/orders')}
<main>
  <section class="panel">
    <h1>订单管理页面</h1>
    <div class="toolbar" role="search">
      <label>
        订单编号
        <input data-testid="order-search-input" placeholder="请输入订单编号" />
      </label>
      <label>
        状态
        <select data-testid="status-filter" aria-label="状态">
          <option>全部</option>
          <option>待审批</option>
          <option>已通过</option>
        </select>
      </label>
      <button data-testid="search-button" type="button">搜索</button>
    </div>
    <table aria-label="订单列表">
      <thead>
        <tr>
          <th>订单编号</th>
          <th>客户</th>
          <th>金额</th>
          <th>订单状态</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr data-order-no="ORD-001" data-status="待审批">
          <td>ORD-001</td>
          <td>上海测试客户</td>
          <td>¥1280.00</td>
          <td><span class="status pending" data-testid="order-status">待审批</span></td>
          <td><button type="button" data-testid="approve-order">审批</button></td>
        </tr>
        <tr data-order-no="ORD-002" data-status="已通过">
          <td>ORD-002</td>
          <td>北京测试客户</td>
          <td>¥860.00</td>
          <td><span class="status approved" data-testid="order-status">已通过</span></td>
          <td><button class="secondary" type="button" data-testid="view-order">查看</button></td>
        </tr>
      </tbody>
    </table>
  </section>
</main>
<dialog aria-label="订单审批弹窗">
  <div class="dialog-body">
    <h2>订单审批</h2>
    <p>确认通过订单 <strong data-testid="dialog-order-no"></strong> 吗？</p>
    <div class="dialog-actions">
      <button class="secondary" data-testid="approval-cancel" type="button">取消</button>
      <button data-testid="approval-pass" type="button">通过</button>
    </div>
  </div>
</dialog>
<script>
  const rows = Array.from(document.querySelectorAll('tbody tr'));
  const searchInput = document.querySelector('[data-testid="order-search-input"]');
  const statusFilter = document.querySelector('[data-testid="status-filter"]');
  const dialog = document.querySelector('dialog');
  const dialogOrderNo = document.querySelector('[data-testid="dialog-order-no"]');
  let activeRow = null;

  function applyFilters() {
    const keyword = searchInput.value.trim();
    const status = statusFilter.value;
    for (const row of rows) {
      const matchesOrder = !keyword || row.dataset.orderNo.includes(keyword);
      const matchesStatus = status === '全部' || row.dataset.status === status;
      row.hidden = !(matchesOrder && matchesStatus);
    }
  }

  document.querySelector('[data-testid="search-button"]').addEventListener('click', applyFilters);
  statusFilter.addEventListener('change', applyFilters);

  document.querySelectorAll('[data-testid="approve-order"]').forEach((button) => {
    button.addEventListener('click', () => {
      activeRow = button.closest('tr');
      dialogOrderNo.textContent = activeRow.dataset.orderNo;
      dialog.showModal();
    });
  });

  document.querySelector('[data-testid="approval-cancel"]').addEventListener('click', () => dialog.close());
  document.querySelector('[data-testid="approval-pass"]').addEventListener('click', () => {
    if (!activeRow) return;
    activeRow.dataset.status = '已通过';
    const status = activeRow.querySelector('[data-testid="order-status"]');
    status.textContent = '已通过';
    status.className = 'status approved';
    dialog.close();
    applyFilters();
  });
</script>`
  );
}

function usersPage(): string {
  return pageShell(
    '用户管理',
    `${headerNav('/users')}
<main>
  <section class="panel">
    <div class="toolbar">
      <h1 style="margin-right:auto">用户管理页面</h1>
      <button data-testid="create-user-button" type="button">新增用户</button>
    </div>
    <div class="toolbar" role="search">
      <label>
        用户关键词
        <input data-testid="user-keyword-input" placeholder="姓名或邮箱" />
      </label>
      <label>
        用户状态
        <select data-testid="user-status-filter" aria-label="用户状态">
          <option>全部</option>
          <option>启用</option>
          <option>禁用</option>
        </select>
      </label>
      <button data-testid="user-search-button" type="button">查询</button>
    </div>
    <table aria-label="用户列表">
      <thead>
        <tr><th>姓名</th><th>邮箱</th><th>角色</th><th>状态</th><th>操作</th></tr>
      </thead>
      <tbody data-testid="user-table-body">
        <tr data-user-name="王审核" data-status="启用">
          <td>王审核</td>
          <td>reviewer@example.com</td>
          <td>审核员</td>
          <td><span data-testid="user-status">启用</span></td>
          <td><button data-testid="edit-user-button" type="button">编辑</button></td>
        </tr>
      </tbody>
    </table>
  </section>
</main>
<dialog aria-label="用户表单弹窗">
  <form class="dialog-body" method="dialog">
    <h2>新增用户</h2>
    <div class="form-grid">
      <label>
        姓名
        <input data-testid="user-name-input" placeholder="请输入姓名" />
        <span class="error" data-testid="user-name-error"></span>
      </label>
      <label>
        邮箱
        <input data-testid="user-email-input" placeholder="请输入邮箱" />
        <span class="error" data-testid="user-email-error"></span>
      </label>
      <label>
        角色
        <select data-testid="user-role-select" aria-label="角色">
          <option>管理员</option>
          <option>审核员</option>
          <option>运营</option>
        </select>
      </label>
      <label>
        状态
        <select data-testid="user-status-select" aria-label="状态">
          <option>启用</option>
          <option>禁用</option>
        </select>
      </label>
    </div>
    <div class="dialog-actions">
      <button class="secondary" data-testid="cancel-user-button" type="button">取消</button>
      <button data-testid="save-user-button" type="button">保存用户</button>
    </div>
  </form>
</dialog>
<div class="toast" role="status" data-testid="user-toast">用户已创建</div>
<script>
  const userDialog = document.querySelector('dialog');
  const userRows = document.querySelector('[data-testid="user-table-body"]');
  const userToast = document.querySelector('[data-testid="user-toast"]');
  document.querySelector('[data-testid="create-user-button"]').addEventListener('click', () => userDialog.showModal());
  document.querySelector('[data-testid="cancel-user-button"]').addEventListener('click', () => userDialog.close());
  document.querySelector('[data-testid="save-user-button"]').addEventListener('click', () => {
    const name = document.querySelector('[data-testid="user-name-input"]').value.trim();
    const email = document.querySelector('[data-testid="user-email-input"]').value.trim();
    const role = document.querySelector('[data-testid="user-role-select"]').value;
    const status = document.querySelector('[data-testid="user-status-select"]').value;
    document.querySelector('[data-testid="user-name-error"]').textContent = name ? '' : '请输入姓名';
    document.querySelector('[data-testid="user-email-error"]').textContent = email ? '' : '请输入邮箱';
    if (!name || !email) return;
    const row = document.createElement('tr');
    row.dataset.userName = name;
    row.dataset.status = status;
    row.innerHTML = '<td>' + name + '</td><td>' + email + '</td><td>' + role + '</td><td><span data-testid="user-status">' + status + '</span></td><td><button data-testid="edit-user-button" type="button">编辑</button></td>';
    userRows.appendChild(row);
    userDialog.close();
    userToast.setAttribute('open', '');
    setTimeout(() => userToast.removeAttribute('open'), 1600);
  });
</script>`
  );
}

function productsPage(): string {
  return pageShell(
    '商品管理',
    `${headerNav('/products')}
<main>
  <section class="panel">
    <h1>商品管理页面</h1>
    <div class="toolbar" role="search">
      <label>
        商品名称
        <input data-testid="product-name-input" placeholder="请输入商品名称" />
      </label>
      <label>
        分类
        <select data-testid="product-category-select" aria-label="分类">
          <option>全部</option>
          <option>数码</option>
          <option>家居</option>
          <option>服饰</option>
        </select>
      </label>
      <label>
        库存状态
        <select data-testid="stock-status-select" aria-label="库存状态">
          <option>全部</option>
          <option>有库存</option>
          <option>缺货</option>
        </select>
      </label>
      <button data-testid="product-search-button" type="button">查询</button>
    </div>
    <table aria-label="商品列表">
      <thead>
        <tr><th>商品名称</th><th>分类</th><th>库存</th><th>商品状态</th><th>操作</th></tr>
      </thead>
      <tbody data-testid="product-table-body">
        <tr data-product-name="机械键盘" data-category="数码" data-stock="有库存" data-status="在售">
          <td>机械键盘</td>
          <td>数码</td>
          <td>有库存</td>
          <td><span data-testid="product-status">在售</span></td>
          <td>
            <div class="menu">
              <button data-testid="product-more-button" type="button">更多</button>
              <div class="menu-list" role="menu">
                <button data-testid="product-edit-menuitem" role="menuitem" type="button">编辑</button>
                <button data-testid="product-offsale-menuitem" role="menuitem" type="button">下架</button>
              </div>
            </div>
          </td>
        </tr>
        <tr data-product-name="收纳箱" data-category="家居" data-stock="缺货" data-status="在售">
          <td>收纳箱</td>
          <td>家居</td>
          <td>缺货</td>
          <td><span data-testid="product-status">在售</span></td>
          <td>
            <div class="menu">
              <button data-testid="product-more-button" type="button">更多</button>
              <div class="menu-list" role="menu">
                <button data-testid="product-edit-menuitem" role="menuitem" type="button">编辑</button>
                <button data-testid="product-offsale-menuitem" role="menuitem" type="button">下架</button>
              </div>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  </section>
</main>
<dialog aria-label="商品下架确认弹窗">
  <div class="dialog-body">
    <h2>确认下架</h2>
    <p>确认下架 <strong data-testid="offsale-product-name"></strong> 吗？</p>
    <div class="dialog-actions">
      <button class="secondary" data-testid="cancel-offsale-button" type="button">取消</button>
      <button class="danger" data-testid="confirm-offsale-button" type="button">确认下架</button>
    </div>
  </div>
</dialog>
<script>
  const productRows = Array.from(document.querySelectorAll('tbody tr'));
  const offsaleDialog = document.querySelector('dialog');
  const offsaleName = document.querySelector('[data-testid="offsale-product-name"]');
  let activeProductRow = null;
  function applyProductFilters() {
    const keyword = document.querySelector('[data-testid="product-name-input"]').value.trim();
    const category = document.querySelector('[data-testid="product-category-select"]').value;
    const stock = document.querySelector('[data-testid="stock-status-select"]').value;
    for (const row of productRows) {
      const nameOk = !keyword || row.dataset.productName.includes(keyword);
      const categoryOk = category === '全部' || row.dataset.category === category;
      const stockOk = stock === '全部' || row.dataset.stock === stock;
      row.hidden = !(nameOk && categoryOk && stockOk);
    }
  }
  document.querySelector('[data-testid="product-search-button"]').addEventListener('click', applyProductFilters);
  document.querySelectorAll('[data-testid="product-more-button"]').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.menu-list').forEach((menu) => menu.removeAttribute('open'));
      button.parentElement.querySelector('.menu-list').setAttribute('open', '');
    });
  });
  document.querySelectorAll('[data-testid="product-offsale-menuitem"]').forEach((button) => {
    button.addEventListener('click', () => {
      activeProductRow = button.closest('tr');
      offsaleName.textContent = activeProductRow.dataset.productName;
      offsaleDialog.showModal();
    });
  });
  document.querySelector('[data-testid="cancel-offsale-button"]').addEventListener('click', () => offsaleDialog.close());
  document.querySelector('[data-testid="confirm-offsale-button"]').addEventListener('click', () => {
    if (!activeProductRow) return;
    activeProductRow.dataset.status = '已下架';
    activeProductRow.querySelector('[data-testid="product-status"]').textContent = '已下架';
    offsaleDialog.close();
  });
</script>`
  );
}

function settingsPage(): string {
  return pageShell(
    '系统设置',
    `${headerNav('/settings')}
<main>
  <section class="panel">
    <h1>系统设置页面</h1>
    <div class="tabs" role="tablist">
      <button class="tab" data-testid="basic-settings-tab" role="tab" aria-selected="true" type="button">基础设置</button>
      <button class="tab" data-testid="notification-settings-tab" role="tab" aria-selected="false" type="button">通知设置</button>
      <button class="tab" data-testid="security-settings-tab" role="tab" aria-selected="false" type="button">安全设置</button>
    </div>
    <section data-testid="basic-settings-panel">
      <div class="form-grid">
        <label>
          系统名称
          <input data-testid="system-name-input" value="测试管理后台" />
        </label>
        <label>
          默认语言
          <select data-testid="language-select" aria-label="默认语言">
            <option>中文</option>
            <option>English</option>
          </select>
        </label>
      </div>
    </section>
    <section data-testid="notification-settings-panel" hidden>
      <div class="form-grid">
        <label>
          邮件通知
          <input data-testid="email-notification-toggle" type="checkbox" />
        </label>
        <label>
          发送频率
          <select data-testid="notification-frequency-select" aria-label="发送频率">
            <option>实时</option>
            <option>每天</option>
            <option>每周</option>
          </select>
        </label>
        <label class="full">
          通知备注
          <textarea data-testid="notification-note-textarea" placeholder="请输入通知备注"></textarea>
        </label>
      </div>
    </section>
    <section data-testid="security-settings-panel" hidden>
      <label>
        二次验证
        <input data-testid="mfa-toggle" type="checkbox" />
      </label>
    </section>
    <div class="dialog-actions" style="margin-top:18px">
      <button data-testid="save-settings-button" type="button">保存设置</button>
    </div>
  </section>
</main>
<div class="toast" role="status" data-testid="settings-toast">设置已保存</div>
<script>
  const tabPairs = [
    ['basic-settings-tab', 'basic-settings-panel'],
    ['notification-settings-tab', 'notification-settings-panel'],
    ['security-settings-tab', 'security-settings-panel']
  ];
  for (const [tabId, panelId] of tabPairs) {
    document.querySelector('[data-testid="' + tabId + '"]').addEventListener('click', () => {
      for (const [otherTabId, otherPanelId] of tabPairs) {
        document.querySelector('[data-testid="' + otherTabId + '"]').setAttribute('aria-selected', otherTabId === tabId ? 'true' : 'false');
        document.querySelector('[data-testid="' + otherPanelId + '"]').hidden = otherPanelId !== panelId;
      }
    });
  }
  document.querySelector('[data-testid="save-settings-button"]').addEventListener('click', () => {
    const toast = document.querySelector('[data-testid="settings-toast"]');
    toast.setAttribute('open', '');
    setTimeout(() => toast.removeAttribute('open'), 1600);
  });
</script>`
  );
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${host}:${port}`);

  if (request.method === 'GET' && url.pathname === '/') {
    redirect(response, '/orders');
    return;
  }

  if (request.method === 'GET' && url.pathname === '/login') {
    sendHtml(response, loginPage());
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/login') {
    const form = new URLSearchParams(await readBody(request));
    if (form.get('username') === 'admin' && form.get('password') === 'admin123') {
      redirect(response, '/orders', {
        'set-cookie': 'ai_pw_demo_session=ok; Path=/; SameSite=Lax'
      });
      return;
    }

    sendHtml(response, loginPage('用户名或密码错误'), 401);
    return;
  }

  if (request.method === 'GET' && url.pathname === '/orders') {
    if (!isAuthenticated(request)) {
      redirect(response, '/login');
      return;
    }

    sendHtml(response, ordersPage());
    return;
  }

  if (request.method === 'GET' && url.pathname === '/users') {
    if (!isAuthenticated(request)) {
      redirect(response, '/login');
      return;
    }

    sendHtml(response, usersPage());
    return;
  }

  if (request.method === 'GET' && url.pathname === '/products') {
    if (!isAuthenticated(request)) {
      redirect(response, '/login');
      return;
    }

    sendHtml(response, productsPage());
    return;
  }

  if (request.method === 'GET' && url.pathname === '/settings') {
    if (!isAuthenticated(request)) {
      redirect(response, '/login');
      return;
    }

    sendHtml(response, settingsPage());
    return;
  }

  response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  response.end('Not found');
});

server.listen(port, host, () => {
  console.log(`Demo server running at http://${host}:${port}`);
  console.log('Login: admin / admin123');
});
