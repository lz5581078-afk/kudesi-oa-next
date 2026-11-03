async function canManageSessionDevices({ companyId, employeeId, permissionKey = 'finance.session-manager.manage', query }) {
  const [employee] = await query(
    `SELECT employee.role_key,
       EXISTS (
         SELECT 1 FROM employee_permission_overrides denied_override
         WHERE denied_override.employee_id = employee.id AND denied_override.effect = 'deny'
           AND denied_override.permission_key = ?
       ) AS has_deny,
       (
         EXISTS (
           SELECT 1 FROM employee_positions employee_position
           JOIN position_permissions permission ON permission.position_id = employee_position.position_id
           WHERE employee_position.employee_id = employee.id AND employee_position.status = 'active'
             AND permission.permission_key = ?
         )
         OR EXISTS (
           SELECT 1 FROM employee_permission_overrides permission_override
           WHERE permission_override.employee_id = employee.id AND permission_override.effect = 'allow'
             AND permission_override.permission_key = ?
         )
         OR EXISTS (
           SELECT 1 FROM employee_roles employee_role
           JOIN roles role ON role.id = employee_role.role_id AND role.company_id = department.company_id
           JOIN role_permissions permission ON permission.role_id = role.id
           WHERE employee_role.employee_id = employee.id AND employee_role.status = 'active'
             AND permission.permission_key = ?
         )
       ) AS has_permission
     FROM employees employee
     JOIN departments department ON department.id = employee.department_id
     WHERE employee.id = ? AND department.company_id = ? AND employee.status = 'active'
     LIMIT 1`,
    [permissionKey, permissionKey, permissionKey, permissionKey, employeeId, companyId]
  );
  if (!employee) return false;
  if (['admin', 'company_admin', 'boss'].includes(employee.role_key)) return true;
  return Number(employee.has_deny) !== 1 && Number(employee.has_permission) === 1;
}

const businessSecretPermissionKeys = Object.freeze({
  stores: 'resources.stores.credentials.view'
});

async function canViewBusinessSecrets({ resource, companyId, employeeId, roleKey, query, authorize = canManageSessionDevices }) {
  if (['admin', 'company_admin', 'boss'].includes(roleKey)) return true;
  const permissionKey = businessSecretPermissionKeys[resource];
  if (!permissionKey) return false;
  return authorize({ companyId, employeeId, permissionKey, query });
}

module.exports = { businessSecretPermissionKeys, canManageSessionDevices, canViewBusinessSecrets };
